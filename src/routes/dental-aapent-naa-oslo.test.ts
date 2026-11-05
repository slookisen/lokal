/**
 * dental-aapent-naa-oslo.test.ts -- A2A dev-request
 * 2026-10-16-finn-tannlege-fasettsider, live check after F1-S4a (lokal#1199,
 * FUNN aapent-naa-badge-regnes-i-utc): Finn-tannlege's «Åpent nå» badge read
 * the weekday and the time from the server's clock, which runs in UTC. At
 * 2026-10-19T18:03Z, 20:03 in Oslo, 8 clinics on the tannlegevakt facet pages
 * said «Åpent nå» after closing.
 *
 *   U  isOpenNow(hours, at) on fixed instants, on the clock in Norway: summer
 *      time (UTC+2) and winter time (UTC+1), the opening time counts and the
 *      closing time does not, the weekday after midnight in Norway, an
 *      overnight entry on its own day, no hours and no entry for the day. The
 *      same answers with the process in TZ=UTC, America/New_York,
 *      Pacific/Auckland and Europe/Oslo. Without `at` it reads the clock.
 *   C  the clinic card on /sted/oslo/kjeveortopedi and /sted/oslo at fixed
 *      clocks, the process in TZ=UTC as the server: «Stengt nå» at 20:03 in
 *      Oslo for a clinic that closes at 20:00, «Åpent nå» at 09:30 for one
 *      that opens at 09:00, «Stengt nå» at 16:30 in winter time for one that
 *      closes at 16:00; a clinic open at every clock keeps «Åpent nå», one
 *      without hours has no badge.
 *   P  the clinic page's opening-hours table: the «Åpent nå» mark is on
 *      today's row in Norway while it is open there, and on no row after
 *      closing.
 *
 * With main's (95ef9587) weekday and time in isOpenNow (the server's clock)
 * and the process in UTC, U1, U3, U4b, U5b, U5c, U6a, U6b, U9, U10, C1, C3,
 * C4, C5, P1 and P3 fail, and more of U under America/New_York and
 * Pacific/Auckland.
 *
 * The clock and the time zone are changed only around synchronous code: the
 * route handlers here render synchronously, and tests/test.ts runs other
 * blocks concurrently, so neither globalThis.Date nor process.env.TZ is ever
 * changed across an await. Node reads TZ again when process.env.TZ is set or
 * deleted; T0 checks that it did.
 *
 * Same harness as dental-landing.test.ts (in-memory dental DB, the router
 * driven through router.handle()).
 *
 * Standalone: npx tsx src/routes/dental-aapent-naa-oslo.test.ts
 * Wired into tests/test.ts via runDentalAapentNaaOsloTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  text: string;
}

type Hours = NonNullable<import("../services/dental-store").DentalAgent["opening_hours"]>;

/**
 * Runs fn with the process in time zone `tz` and puts the previous zone back
 * before it returns. fn must be synchronous.
 */
function inTimeZone<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

/**
 * Runs fn with the clock at `iso`: `new Date()` and Date.now() give that
 * instant, Date with arguments is unchanged. fn must be synchronous.
 */
function atClock<T>(iso: string, fn: () => T): T {
  const RealDate = Date;
  const fixed = RealDate.parse(iso);
  class FixedDate extends RealDate {
    constructor(...args: any[]) {
      if (args.length) super(...(args as [number]));
      else super(fixed);
    }
    static now(): number { return fixed; }
  }
  globalThis.Date = FixedDate as unknown as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** GET `url` on the router; null when the handler did not answer synchronously. */
function callRouteSync(router: any, url: string): RouteResult | null {
  const parsed = new URL(url, "http://finn-tannlege.test");
  const query: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => { query[k] = v; });
  let result: RouteResult | null = null;
  const req: any = {
    method: "GET", url, originalUrl: url, path: parsed.pathname,
    params: {}, query, headers: {}, ip: "203.0.113.7", get() { return undefined; },
  };
  const res: any = {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    setHeader() { return this; },
    header() { return this; },
    send(payload: any) { result = { status: this.statusCode, text: String(payload ?? "") }; return this; },
    json(payload: any) { result = { status: this.statusCode, text: JSON.stringify(payload) }; return this; },
  };
  router.handle(req, res, (err?: any) => { result = { status: err ? 500 : 404, text: err ? String(err) : "unhandled" }; });
  return result;
}

/** The route's answer at `iso`, the process in UTC as the server. */
function renderAt(router: any, iso: string, url: string): RouteResult | null {
  return inTimeZone("UTC", () => atClock(iso, () => callRouteSync(router, url)));
}

/** The <article class="clinic-card"> that names `navn`, or "". */
function cardOf(html: string, navn: string): string {
  return Array.from(html.matchAll(/<article class="clinic-card">([\s\S]*?)<\/article>/g), (m) => m[1]!)
    .find((c) => c.includes(`>${navn}</a>`)) ?? "";
}

/** The card's open-now badge: "Åpent nå", "Stengt nå", "" (none) or "both" (a bug). */
function badgeOf(card: string): string {
  const open = /<span class="badge badge-open">[\s\S]*?Åpent nå<\/span>/.test(card);
  const closed = /<span class="badge badge-closed">[\s\S]*?Stengt nå<\/span>/.test(card);
  return open && closed ? "both" : open ? "Åpent nå" : closed ? "Stengt nå" : "";
}

/** The day names of the opening-hours table's rows that carry the «Åpent nå» mark; null without the table. */
function markedRows(html: string): string[] | null {
  const table = (html.match(/<table class="hours-table" aria-label="Åpningstider"><tbody>([\s\S]*?)<\/tbody><\/table>/) || [])[1];
  if (table === undefined) return null;
  return Array.from(table.matchAll(/<tr><td>([^<]*)<\/td><td>[^<]*<\/td><td>([\s\S]*?)<\/td><\/tr>/g))
    .filter((m) => m[2]!.includes("Åpent nå"))
    .map((m) => m[1]!);
}

// Fixed instants. 2026-10-19 is a Monday; summer time (UTC+2) ends on 2026-10-25.
const MON_2003_OSLO = "2026-10-19T18:03:00Z"; // the live check: 20:03 in Oslo
const MON_1959_OSLO = "2026-10-19T17:59:00Z";
const MON_0930_OSLO = "2026-10-19T07:30:00Z";
const MON_0859_OSLO = "2026-10-19T06:59:00Z";
const MON_0900_OSLO = "2026-10-19T07:00:00Z";
const MON_2300_OSLO = "2026-10-19T21:00:00Z";
const MON_0030_OSLO = "2026-10-18T22:30:00Z"; // still Sunday in UTC
// 2026-11-02 is a Monday in winter time (UTC+1).
const WINTER_MON_1559_OSLO = "2026-11-02T14:59:00Z";
const WINTER_MON_1600_OSLO = "2026-11-02T15:00:00Z";
const WINTER_MON_1630_OSLO = "2026-11-02T15:30:00Z";

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"] as const;
const weekdays = (open: string, close: string): Hours => WEEKDAYS.map((day) => ({ day, open, close }));
const UNTIL_20 = weekdays("08:00", "20:00");
const FROM_09 = weekdays("09:00", "16:00");
const UNTIL_16 = weekdays("08:00", "16:00");
const LONG_DAY = weekdays("07:00", "21:00");

export async function runDentalAapentNaaOsloTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

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
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }

  const prevDentalPath = process.env.DENTAL_DB_PATH;
  process.env.DENTAL_DB_PATH = ":memory:";
  const prevLog = console.log;

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("../services/dental-store"),
    require.resolve("../services/dental-area-facts"),
    require.resolve("./dental-landing"),
    require.resolve("./dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    if (!log) console.log = () => { /* silence schema chatter */ };
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    console.log = prevLog;
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const areaFacts = require("../services/dental-area-facts") as typeof import("../services/dental-area-facts");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const { __resetDentalSearchGazetteerForTesting } = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    const router = dentalSeo.default as any;
    const { isOpenNow } = dentalSeo;
    __resetDentalSearchGazetteerForTesting();
    areaFacts.__resetDentalAreaFactsForTesting();
    dentalSeo.__resetDentalSitemapCacheForTesting();

    // ── U: isOpenNow on the clock in Norway, whatever the process's zone ──
    const unitCases: Array<[string, Hours | null, string, boolean]> = [
      ["U1: Monday 20:03 in Oslo (18:03 UTC), open 08:00–20:00: closed (the live check)", UNTIL_20, MON_2003_OSLO, false],
      ["U2: Monday 19:59 in Oslo, open 08:00–20:00: open", UNTIL_20, MON_1959_OSLO, true],
      ["U3: Monday 09:30 in Oslo (07:30 UTC), open 09:00–16:00: open", FROM_09, MON_0930_OSLO, true],
      ["U4a: Monday 08:59 in Oslo, open 09:00–16:00: closed", FROM_09, MON_0859_OSLO, false],
      ["U4b: Monday 09:00 in Oslo, open 09:00–16:00: open (the opening time counts)", FROM_09, MON_0900_OSLO, true],
      ["U5a: winter time, Monday 15:59 in Oslo, open 08:00–16:00: open", UNTIL_16, WINTER_MON_1559_OSLO, true],
      ["U5b: winter time, Monday 16:00 in Oslo (15:00 UTC), open 08:00–16:00: closed (the closing time does not count)", UNTIL_16, WINTER_MON_1600_OSLO, false],
      ["U5c: winter time, Monday 16:30 in Oslo (15:30 UTC), open 08:00–16:00: closed", UNTIL_16, WINTER_MON_1630_OSLO, false],
      ["U6a: Monday 00:30 in Oslo (Sunday 22:30 UTC), open Sunday 20:00–23:59: closed (the weekday is Norway's)", [{ day: "sun", open: "20:00", close: "23:59" }], MON_0030_OSLO, false],
      ["U6b: Monday 00:30 in Oslo (Sunday 22:30 UTC), open Monday 00:00–08:00: open", [{ day: "mon", open: "00:00", close: "08:00" }], MON_0030_OSLO, true],
      ["U7a: no hours: closed", null, MON_0930_OSLO, false],
      ["U7b: an empty list: closed", [], MON_0930_OSLO, false],
      ["U8: no entry for Monday: closed", [{ day: "tue", open: "00:00", close: "23:59" }], MON_0930_OSLO, false],
      ["U9: an overnight entry, Monday 22:00–02:00, at 23:00 in Oslo (21:00 UTC): open", [{ day: "mon", open: "22:00", close: "02:00" }], MON_2300_OSLO, true],
    ];
    // T0: the zone really changes (offset of 2026-10-19 in minutes, as getTimezoneOffset gives it).
    const zones: Array<[string, number]> = [["UTC", 0], ["America/New_York", 240], ["Pacific/Auckland", -780], ["Europe/Oslo", -120]];
    const tzBefore = process.env.TZ;
    const offsetBefore = new Date(MON_2003_OSLO).getTimezoneOffset();
    for (const [tz, offset] of zones) {
      const { seenOffset, answers } = inTimeZone(tz, () => ({
        seenOffset: new Date(MON_2003_OSLO).getTimezoneOffset(),
        answers: unitCases.map(([, hours, iso]) => isOpenNow(hours, new Date(iso))),
      }));
      assertEq(seenOffset, offset, `T0 ${tz}: the process runs in ${tz} for the cases below`);
      unitCases.forEach(([label, , , expected], i) => assertEq(answers[i], expected, `${label} [TZ=${tz}]`));
    }
    assertEq([process.env.TZ, new Date(MON_2003_OSLO).getTimezoneOffset()], [tzBefore, offsetBefore], "T1: the process's zone is put back");
    assertEq(
      inTimeZone("UTC", () => [atClock(MON_2003_OSLO, () => isOpenNow(UNTIL_20)), atClock(MON_0930_OSLO, () => isOpenNow(FROM_09))]),
      [false, true],
      "U10: without `at` it reads the clock: closed at 20:03 and open at 09:30 in Oslo, the process in UTC"
    );

    // ── fixture: four kjeveortopedi clinics in Oslo (one Helfo, so the
    //    kjeveortopedi facet passes the gate: 4 clinics, 2 facts). The
    //    tannlegevakt facet, where the live check saw the badge, is off since
    //    F1-S4c; the facet pages share the card. ──
    let orgSeq = 928990000;
    const KJEVE = '["kjeveortopedi"]';
    // F2-S6: the Helfo fact needs a stored source (resolveHelfoClaim).
    const HELFO_PROV = JSON.stringify({ helfo_agreement: [{ value: "true", source_type: "homepage", source_url: "https://example.test/helfo", fetched_at: "2026-05-01T10:00:00Z" }] });
    const mk = (navn: string, hours: Hours | null, helfo = false): string => {
      const id = store.createDentalAgent({ navn, org_nr: String(++orgSeq), poststed: "OSLO", fylke: "Oslo", adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare(
        "UPDATE dental_agents SET catalog_class = 'klinikk', is_inactive = 0, verification_status = 'unverified', helfo_agreement = ?," +
        " field_provenance = ?, available_specialties = ?, opening_hours = ? WHERE id = ?"
      ).run(helfo ? "true" : "unknown", helfo ? HELFO_PROV : null, KJEVE, hours === null ? null : JSON.stringify(hours), id);
      return id;
    };
    const KVELD = "Oslo Kveld Tann AS";
    const MORGEN = "Oslo Morgen Tann AS";
    const LANG = "Oslo Langdag Tann AS";
    const UTEN = "Oslo Uten Tider Tann AS";
    const idKveld = mk(KVELD, UNTIL_20, true);
    const idMorgen = mk(MORGEN, FROM_09);
    mk(LANG, LONG_DAY);
    mk(UTEN, null);

    // ── C: the clinic cards, the process in UTC as the server ──
    const badges = (iso: string, url: string): Record<string, string> | null => {
      const r = renderAt(router, iso, url);
      if (!r || r.status !== 200) return null;
      return Object.fromEntries([KVELD, MORGEN, LANG, UTEN].map((n) => [n, badgeOf(cardOf(r.text, n))]));
    };
    const facetEve = badges(MON_2003_OSLO, "/sted/oslo/kjeveortopedi");
    assertTrue(facetEve !== null, "C0: /sted/oslo/kjeveortopedi answers 200, synchronously");
    assertEq(facetEve?.[KVELD], "Stengt nå", "C1: /sted/oslo/kjeveortopedi at 20:03 in Oslo: «Stengt nå» for the clinic that closes at 20:00 (main: «Åpent nå»)");
    assertEq(facetEve?.[LANG], "Åpent nå", "C2: /sted/oslo/kjeveortopedi at 20:03 in Oslo: «Åpent nå» for the clinic open until 21:00");
    const facetMorning = badges(MON_0930_OSLO, "/sted/oslo/kjeveortopedi");
    assertEq(facetMorning?.[MORGEN], "Åpent nå", "C3: /sted/oslo/kjeveortopedi at 09:30 in Oslo: «Åpent nå» for the clinic that opens at 09:00 (main: «Stengt nå»)");
    assertEq([facetMorning?.[KVELD], facetMorning?.[LANG]], ["Åpent nå", "Åpent nå"], "C4: /sted/oslo/kjeveortopedi at 09:30 in Oslo: the two others open");
    const stedWinter = badges(WINTER_MON_1630_OSLO, "/sted/oslo");
    assertTrue(stedWinter !== null, "C0b: /sted/oslo answers 200, synchronously");
    assertEq(stedWinter?.[MORGEN], "Stengt nå", "C5: /sted/oslo in winter time at 16:30 in Oslo (15:30 UTC): «Stengt nå» for the clinic that closes at 16:00 (main: «Åpent nå»)");
    assertEq([stedWinter?.[KVELD], stedWinter?.[LANG]], ["Åpent nå", "Åpent nå"], "C6: /sted/oslo in winter time at 16:30 in Oslo: the two open until 20:00 and 21:00 say «Åpent nå»");
    assertEq([facetEve?.[UTEN], facetMorning?.[UTEN], stedWinter?.[UTEN]], ["", "", ""], "C7: the clinic without hours has no open-now badge");

    // ── P: the clinic page's opening-hours table ──
    const rowsAt = (iso: string, id: string): string[] | null => {
      const r = renderAt(router, iso, `/klinikk/id/${id}`);
      return r && r.status === 200 ? markedRows(r.text) : null;
    };
    assertEq(rowsAt(MON_2003_OSLO, idKveld), [], "P1: the clinic that closes at 20:00, at 20:03 in Oslo: no row says «Åpent nå» (main: Mandag)");
    assertEq(rowsAt(MON_1959_OSLO, idKveld), ["Mandag"], "P2: the same clinic at 19:59 in Oslo: the Monday row says «Åpent nå»");
    assertEq(rowsAt(MON_0930_OSLO, idMorgen), ["Mandag"], "P3: the clinic that opens at 09:00, at 09:30 in Oslo (07:30 UTC): the Monday row says «Åpent nå» (main: none)");
    assertEq(rowsAt(WINTER_MON_1559_OSLO, idMorgen), ["Mandag"], "P4: the same clinic in winter time at 15:59 in Oslo: the Monday row says «Åpent nå»");
  } catch (err: any) {
    failed++;
    failures.push("dental «Åpent nå» in Oslo time: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    if (prevDentalPath === undefined) delete process.env.DENTAL_DB_PATH;
    else process.env.DENTAL_DB_PATH = prevDentalPath;
    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
    } catch {
      // best-effort cleanup
    }
    restoreModuleCache();
  }

  return { passed, failed, failures };
}

if (require.main === module) {
  runDentalAapentNaaOsloTests({ log: true }).then((r) => {
    console.log(`\ndental «Åpent nå» in Oslo time: ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
