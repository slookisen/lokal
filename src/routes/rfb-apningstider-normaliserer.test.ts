/**
 * rfb-apningstider-normaliserer.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-H (FUNN
 * rfb-apningstider-alternative-former, rfb-isopennow-lange-dagnavn and
 * a2a-produsent-agent-json-404 from the lokal#1114 review).
 *
 * On main (ca0f313f) the producer page showed no opening hours for {day,
 * hours}, {day, from, to}, {days, …}, {period, …} and note-only entries,
 * lokal_info and the A2A auto-reply left them out, the front page's "open now"
 * matched only "mon"…"sun" (so "monday" or "Mandag-Søndag" said "Stengt" in
 * opening hours, and a REKO ring's "Varierer" said "Stengt" every day), and
 * JSON-LD wrote stored keys after "https://schema.org/" ("…/mon-fri",
 * "…/Varierer"). All four now read utils/opening-hours.ts.
 *
 * Covers, on the real handlers with an in-memory DB:
 *   (a) producer page, one producer per stored form (no and en): the hours
 *       card shows the days and times or the text, the FAQ says hours are
 *       listed, JSON-LD has only valid weekdays (none for labels that are no
 *       weekday, or a period) and opens/closes as "HH:MM" (none for
 *       "closed", which is a closed day "Stengt"), the "today" highlight
 *       covers a range, is the day in Norway (fixed clock at 22:30Z) and
 *       skips an entry that holds only in a period, no junk.
 *   (b) front page at fixed clocks: featured producers with long English day
 *       names (open past midnight) and a Norwegian range say "Åpent nå" in
 *       their hours, also after midnight on the previous day's entry, and
 *       "Stengt" after closing; a REKO ring with only "Varierer" says nothing
 *       (main: "Stengt" for all three).
 *   (c) lokal_info and the auto-reply give the same hours text for every
 *       producer, and each time on the page is in it.
 *   (d) GET /agents/:id/agent.json is seed-store only (see a2a.ts): no
 *       non-test source file links it, so no discovery surface points at a
 *       route that answers 404 for marketplace producers.
 *   (e) slice I-J (FUNN rfb-apningstider-to-uleste-former), producers
 *       added to the fixture above: Hovdneset Gård (schema.org's form) shows
 *       "Fredag 12:00 – 17:00" with its period and note and has JSON-LD with
 *       validFrom/validThrough; Små Vesen ({byAppointment: true,
 *       description}) shows "Etter avtale" and its description (main: no
 *       hours card for either); URIs, lists, a period with one end and a
 *       DayOfWeek that is no weekday; every page's JSON-LD has only the
 *       seven weekdays and validity only as two ISO dates in order; the
 *       "today" highlight skips entries with a period. Their lokal_info and
 *       auto-reply lines are in (c).
 *
 * Exported runRfbApningstiderNormalisererTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/rfb-apningstider-normaliserer.test.ts
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface CapturedTool {
  config: unknown;
  handler: (args: any) => Promise<any>;
}

/** The inner HTML of the hours card grid. */
function hoursGrid(body: string): string | null {
  const m = /<div class="hrs-grid">(.*)<\/div><\/div>\n/.exec(body);
  return m ? m[1]! : null;
}

/** The page without the "today" highlight, which depends on the weekday the test runs. */
function withoutToday(html: string): string {
  return html.replace(/ hrs-today/g, "").replace(/<span class="hrs-open"><span class="hrs-dot"><\/span> [^<]*<\/span>/g, "");
}

function jsonLdBlocks(body: string): any[] {
  return [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]!));
}

/** "undefined", "[object Object]" or "NaN" in the visible HTML or in a JSON-LD string. */
function junk(body: string): string[] {
  const visible = body.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "").replace(/<style[^>]*>[\s\S]*?<\/style>/g, "");
  const found = [...visible.matchAll(/.{0,40}(\[object Object\]|\bundefined\b|\bNaN\b).{0,20}/g)].map((m) => m[0]);
  for (const ld of jsonLdBlocks(body)) {
    JSON.stringify(ld, (_k, v) => {
      if (typeof v === "string" && /\[object Object\]|undefined|NaN/.test(v)) found.push(`JSON-LD: ${v}`);
      return v;
    });
  }
  return found;
}

/**
 * Runs fn with the clock at `iso`: `new Date()` and Date.now() inside the
 * handlers (which read the clock themselves) give that instant. Date with
 * arguments is unchanged.
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
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

/** The day labels of the rows the hours card highlights as today. */
function todayRows(grid: string): string[] {
  return [...grid.matchAll(/<div class="hrs-day hrs-today">([^<]*)/g)].map((m) => m[1]!);
}

/** Every non-test source file under a directory. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|js|html|json|txt|md)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

export async function runRfbApningstiderNormalisererTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  const { __setDbForTesting, __initSchemaForTesting, __peekDbForTesting } = require("../database/init") as
    typeof import("../database/init");
  const { __setGeocodingFetchForTesting, __clearGeocodeCacheForTesting } = require("../services/geocoding-service") as
    typeof import("../services/geocoding-service");
  const prevDb = __peekDbForTesting();
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = DELETE");
  testDb.pragma("foreign_keys = OFF");
  const origLog = console.log;
  const origError = console.error;

  try {
    __setDbForTesting(testDb as any);
    __initSchemaForTesting(testDb as any);
    __setGeocodingFetchForTesting((async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)) as typeof fetch);
    __clearGeocodeCacheForTesting();
    const { loadConfigsAtBoot } = require("../config/vertical-config") as typeof import("../config/vertical-config");
    try { loadConfigsAtBoot(); } catch { /* already loaded */ }

    // ══ fixture: one producer per stored form (shapes from live data 2026-10-17) ══
    function seedProducer(row: { id: string; name: string; city: string; geo: [number, number]; trust?: number; claimed?: boolean; hours: unknown }): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
          '["vegetables"]', '[]', '[]', '{}', '["no"]', ?, ?, ?,
          ?, 1, 1, 0, 0, 0, 0, '2026-08-01 10:00:00', '2026-08-01 10:00:00')`,
      ).run(
        row.id, row.name, "Lokal produsent med gardsutsalg og mye godt.", row.name, `${row.id}@example.no`,
        "https://example.no", `key-${row.id}`, row.city, row.geo[0], row.geo[1], row.trust ?? 0.5,
      );
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, updated_at, created_at, enrichment_status, products, opening_hours)
         VALUES (?, '2026-08-01 10:00:00', '2026-08-01 10:00:00', 'enriched', ?, ?)`,
      ).run(row.id, JSON.stringify([{ name: "Poteter", category: "vegetables" }]), JSON.stringify(row.hours));
      if (row.claimed) {
        testDb.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
           VALUES (?, ?, 'Eier', ?, 'verified', '2026-08-01 10:00:00')`,
        ).run(`claim-${row.id}`, row.id, `${row.id}-owner@example.no`);
      }
    }
    const P = {
      // {day, hours} with Norwegian and nynorsk day names and a closed day (Røtter Frogner, Sognasmak).
      hours: { id: "ih-hours", name: "Hanne Timer", slug: "hanne-timer", hours: [
        { day: "Mandag", hours: "Stengt" }, { day: "Tysdag-Onsdag", hours: "10:00-16:00" },
        { day: "Mandag-Fredag", hours: "10:00-19:00" }, { day: "Lørdag", hours: "11:00-18:00" },
      ] },
      // {day, from, to} with labels that name no weekday (Tysnes Gårdsysteri).
      fromTo: { id: "ih-fromto", name: "Frode Fratil", slug: "frode-fratil", hours: [
        { day: "Påske", from: "12:00", to: "18:00" }, { day: "Fre–lør (sesong)", from: "12:00", to: "20:00" },
      ] },
      // Notes without times (Rånås Gård, Engøy Gjestegård, {note}).
      notes: { id: "ih-notes", name: "Nora Notat", slug: "nora-notat", hours: [
        { day: "by-appointment", note: "Åpent etter avtale — ring eller send SMS" },
        { day: "note", open: "1. juli - 31. juli: Mandag-søndag 09:00-16:00" },
        { note: "Selvbetjent <bod> & kjøleskap" },
      ] },
      // {period, days, …} and {days: [...]} (Ciderhuset Balestrand, Velure Gard).
      period: { id: "ih-period", name: "Per Periode", slug: "per-periode", hours: [
        { period: "April", days: "Torsdag–Fredag", open: "12:00", close: "16:00" },
        { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], open: "08:00", close: "18:00" },
      ] },
      // A range every day, so "today" is always highlighted (main never highlighted a range).
      range: { id: "ih-range", name: "Rita Rekkevidde", slug: "rita-rekkevidde", hours: [{ day: "mon-sun", open: "00:00", close: "24:00", note: "Døgnåpen selvbetjent" }] },
      // "closed" as the times (Aarsland Gårdsutsalg, Havens Kolonial, The ODD Bakery, Haugli Bakeri),
      // times that are not "HH:MM", and hours past midnight (Tromsø Mikrobryggeri).
      closed: { id: "ih-closed", name: "Stine Stengt", slug: "stine-stengt", hours: [
        { day: "sun", open: "closed", close: "closed" }, { day: "Tirsdag", hours: "12.00 – 18.00" },
        { day: "sat", open: 10, close: 17 }, { day: "fri", open: "9:00", close: "17:30" }, { day: "thu", open: "18:00", close: "01:30" },
      ] },
      // I-J: schema.org's form, the stored value of Hovdneset Gård (4e2afba3-…, live 2026-10-17).
      hovdneset: { id: "ij-hovdneset", name: "Hovdneset Gård — Rena", slug: "hovdneset-gard-rena", hours: [
        { dayOfWeek: "Friday", opens: "12:00", closes: "17:00", description: "Grønnsakstor på Rena torg – sesongutsalg, juli–oktober", validFrom: "2026-07-01", validThrough: "2026-10-31" },
      ] },
      // I-J: {byAppointment: true, description}, the stored value of Små Vesen (5045eaa7-…, live 2026-10-17).
      smaVesen: { id: "ij-smavesen", name: "Små Vesen", slug: "sma-vesen", hours: [
        { description: "Utsalet i bryggeriet er ope på førespurnad – ring 476 82 708. Elles når det er annonsert på Facebook. Sjølvbetening frå kjøleskåp utanfor døra (alkoholfri drikke og ølglas), betal med Vipps.", byAppointment: true },
      ] },
      // I-J: schema.org's form with URIs, a list, validity across a new year,
      // a period with one end and a DayOfWeek that is no weekday, beside the
      // declared form.
      schema: { id: "ij-schema", name: "Siri Skjema", slug: "siri-skjema", hours: [
        { dayOfWeek: ["https://schema.org/Saturday", "https://schema.org/Sunday"], opens: "10:00", closes: "15:00" },
        { dayOfWeek: "http://schema.org/Monday", opens: "9", closes: "14.30", description: "Vintertid", validFrom: "2026-11-01", validThrough: "2027-03-31" },
        { dayOfWeek: "Wednesday", opens: "10:00", closes: "14:00", validFrom: "2026-07-01" },
        { dayOfWeek: "https://schema.org/PublicHolidays", opens: "12:00", closes: "15:00" },
        { day: "thu", open: "10:00", close: "17:00" },
      ] },
    };
    seedProducer({ ...P.hours, city: "Oslo", geo: [59.91, 10.75] });
    seedProducer({ ...P.fromTo, city: "Tysnes", geo: [59.99, 5.5] });
    seedProducer({ ...P.notes, city: "Hamar", geo: [60.79, 11.07] });
    seedProducer({ ...P.period, city: "Balestrand", geo: [61.2, 6.53] });
    seedProducer({ ...P.range, city: "Moss", geo: [59.43, 10.66] });
    seedProducer({ ...P.closed, city: "Bergen", geo: [60.39, 5.32] });
    seedProducer({ ...P.hovdneset, city: "Rena", geo: [61.13, 11.37] });
    seedProducer({ ...P.smaVesen, city: "Aurdal", geo: [60.93, 9.4] });
    seedProducer({ ...P.schema, city: "Lillehammer", geo: [61.11, 10.47] });
    // Front page: the three claimed producers with the highest trust get the ultra-rich card.
    const allWeek = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    seedProducer({ id: "ih-c-long", name: "Kari Langnavn", city: "Ctown", geo: [60.0, 10.0], claimed: true, trust: 0.99,
      hours: allWeek.map((day) => ({ day, open: "12:00", close: "03:00" })) });
    seedProducer({ id: "ih-c-range", name: "Kjell Norskuke", city: "Ctown", geo: [60.0, 10.0], claimed: true, trust: 0.98,
      hours: [{ day: "Mandag-Søndag", hours: "00:00-24:00" }] });
    seedProducer({ id: "ih-c-reko", name: "REKO Testringen", city: "Ctown", geo: [60.0, 10.0], claimed: true, trust: 0.97,
      hours: [{ day: "Varierer", open: "16:00", close: "17:00", note: "Utlevering skjer på avtalt tid og sted." }] });

    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    delete require.cache[require.resolve("./seo")];
    const seo = require("./seo") as typeof import("./seo");
    const router = seo.default as any;
    function handlerFor(routePath: string): any {
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.get);
      if (!layer) throw new Error(`GET ${routePath} is not registered`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    function invoke(handler: any, req: any): { status: number; body: string } {
      let status = 200;
      let body = "";
      const res: any = {
        status: (c: number) => { status = c; return res; },
        send: (b: unknown) => { body = typeof b === "string" ? b : String(b); return res; },
        redirect: () => { status = 301; return res; },
        setHeader: () => res,
        set: () => res,
        locals: {},
      };
      console.log = () => {};
      console.error = () => {};
      try { handler(req, res, () => { status = -1; }); } finally { console.log = origLog; console.error = origError; }
      return { status, body };
    }
    const producerHandler = handlerFor("/produsent/:slug");
    const homeHandler = handlerFor("/");
    const producer = (slug: string, lang: "no" | "en" = "no") =>
      invoke(producerHandler, { params: { slug }, lang, ip: "127.0.0.1", headers: {}, get: () => undefined, query: {} });
    const home = (lang: "no" | "en", iso: string) =>
      atClock(iso, () => invoke(homeHandler, { lang, query: {}, ip: "127.0.0.1", headers: {}, get: () => undefined }));
    const specDays = (body: string) => (jsonLdBlocks(body).find((b) => b["@type"] === "LocalBusiness")?.openingHoursSpecification ?? [])
      .map((s: any) => s.dayOfWeek);
    const faqClaimsHours = (body: string) => JSON.stringify(jsonLdBlocks(body).find((b) => b["@type"] === "FAQPage") ?? {}).includes("har åpningstider oppført");
    const sd = (...days: string[]) => days.map((d) => `https://schema.org/${d}`);

    // ══ (a) producer page ════════════════════════════════════════════════
    const pages: Record<string, { no: string; en: string }> = {};
    for (const p of Object.values(P)) {
      const no = producer(p.slug);
      const en = producer(p.slug, "en");
      assertEq([no.status, en.status], [200, 200], `a ${p.slug}: 200 (no, en)`);
      assertTrue(faqClaimsHours(no.body), `a ${p.slug}: the FAQ says hours are listed (main: not for this form)`);
      assertEq(junk(no.body).concat(junk(en.body)), [], `a ${p.slug}: no junk text (no, en)`);
      pages[p.slug] = { no: no.body, en: en.body };
    }
    assertEq(withoutToday(hoursGrid(pages["hanne-timer"]!.no) ?? ""),
      "<div class=\"hrs-day\">Mandag</div><div class=\"hrs-time\">Stengt</div>" +
      "<div class=\"hrs-day\">Tirsdag–Onsdag</div><div class=\"hrs-time\">10:00 – 16:00</div>" +
      "<div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">10:00 – 19:00</div>" +
      "<div class=\"hrs-day\">Lørdag</div><div class=\"hrs-time\">11:00 – 18:00</div>",
      "a {day, hours}: the days and times, a closed day as \"Stengt\" (main: no hours card)");
    assertEq(withoutToday(hoursGrid(pages["hanne-timer"]!.en) ?? ""),
      "<div class=\"hrs-day\">Monday</div><div class=\"hrs-time\">Stengt</div>" +
      "<div class=\"hrs-day\">Tuesday–Wednesday</div><div class=\"hrs-time\">10:00 – 16:00</div>" +
      "<div class=\"hrs-day\">Monday–Friday</div><div class=\"hrs-time\">10:00 – 19:00</div>" +
      "<div class=\"hrs-day\">Saturday</div><div class=\"hrs-time\">11:00 – 18:00</div>",
      "a {day, hours} /en: Norwegian and nynorsk day names in English");
    assertEq(specDays(pages["hanne-timer"]!.no), [sd("Tuesday", "Wednesday"), sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday"), sd("Saturday")[0]],
      "a {day, hours}: JSON-LD for the timed entries, valid weekdays; the closed day has no times and no entry");
    assertEq(withoutToday(hoursGrid(pages["frode-fratil"]!.no) ?? ""),
      "<div class=\"hrs-day\">Påske</div><div class=\"hrs-time\">12:00 – 18:00</div>" +
      "<div class=\"hrs-day\">Fre–lør (sesong)</div><div class=\"hrs-time\">12:00 – 20:00</div>",
      "a {day, from, to}: from/to are the times; a label that is no weekday is shown as written");
    assertEq(specDays(pages["frode-fratil"]!.no), [], "a {day, from, to}: no JSON-LD hours for labels that are no weekday");
    assertEq(hoursGrid(pages["nora-notat"]!.no),
      "<div class=\"hrs-day\"></div><div class=\"hrs-time\">Åpent etter avtale — ring eller send SMS</div>" +
      "<div class=\"hrs-day\"></div><div class=\"hrs-time\">1. juli - 31. juli: Mandag-søndag 09:00-16:00</div>" +
      "<div class=\"hrs-day\"></div><div class=\"hrs-time\">Selvbetjent &lt;bod&gt; &amp; kjøleskap</div>",
      "a notes: each note is a text row, escaped; the markers \"by-appointment\" and \"note\" are not shown");
    assertEq(specDays(pages["nora-notat"]!.no), [], "a notes: no JSON-LD hours");
    assertEq(withoutToday(hoursGrid(pages["per-periode"]!.no) ?? ""),
      "<div class=\"hrs-day\">Torsdag–Fredag</div><div class=\"hrs-time\">12:00 – 16:00 (April)</div>" +
      "<div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">08:00 – 18:00</div>",
      "a {period, days, …} and {days: [...]}: the period is shown with its times");
    assertEq(specDays(pages["per-periode"]!.no), [sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")],
      "a period: an entry that holds only in a period has no JSON-LD (no validity dates); the year-round one does");
    {
      const grid = hoursGrid(pages["rita-rekkevidde"]!.no) ?? "";
      assertTrue(/^<div class="hrs-day hrs-today">Mandag–Søndag<span class="hrs-open">/.test(grid) && grid.includes("<div class=\"hrs-time hrs-today\">00:00 – 24:00 (Døgnåpen selvbetjent)</div>"),
        "a today: a range that covers today is highlighted (main matched only \"mon\"…\"sun\" and the long names)");
      assertEq(specDays(pages["rita-rekkevidde"]!.no), [sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")],
        "a mon-sun: JSON-LD lists the seven days (main: \"https://schema.org/mon-sun\")");
    }
    {
      const page = pages["stine-stengt"]!.no;
      assertEq(withoutToday(hoursGrid(page) ?? ""),
        "<div class=\"hrs-day\">Søndag</div><div class=\"hrs-time\">Stengt</div>" +
        "<div class=\"hrs-day\">Tirsdag</div><div class=\"hrs-time\">12.00 – 18.00</div>" +
        "<div class=\"hrs-day\">Lørdag</div><div class=\"hrs-time\">10 – 17</div>" +
        "<div class=\"hrs-day\">Fredag</div><div class=\"hrs-time\">9:00 – 17:30</div>" +
        "<div class=\"hrs-day\">Torsdag</div><div class=\"hrs-time\">18:00 – 01:30</div>",
        "a closed: \"closed\" as the times is \"Stengt\" (head before: \"closed – closed\"); other times as stored");
      const sp = (day: string, opens: string, closes: string) => ({ "@type": "OpeningHoursSpecification", dayOfWeek: `https://schema.org/${day}`, opens, closes });
      assertEq(jsonLdBlocks(page).find((b) => b["@type"] === "LocalBusiness")?.openingHoursSpecification,
        [sp("Tuesday", "12:00", "18:00"), sp("Saturday", "10:00", "17:00"), sp("Friday", "09:00", "17:30"), sp("Thursday", "18:00", "01:30")],
        "a closed: JSON-LD opens/closes are \"HH:MM\" (\"12.00\", 10 and \"9:00\" formatted; a closing time past midnight kept); the closed day has none (head before: \"opens\": \"closed\")");
      const visible = page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
      assertTrue(!/\bclosed\b/i.test(visible) && !/"closed"/.test(JSON.stringify(jsonLdBlocks(page))), "a closed: the word \"closed\" is nowhere on the page or in its JSON-LD");
    }
    // The "today" highlight at a fixed clock. 2026-10-14 is a Wednesday:
    // 21:30Z is Wednesday 23:30 in Oslo, 22:30Z is Thursday 00:30 there while
    // the server (UTC on Fly) is still on Wednesday.
    {
      const at = (slug: string, iso: string) => todayRows(hoursGrid(atClock(iso, () => producer(slug)).body) ?? "");
      assertEq(at("hanne-timer", "2026-10-14T21:30:00Z"), ["Tirsdag–Onsdag", "Mandag–Fredag"], "a today: Wednesday 23:30 in Oslo highlights the entries for Wednesday");
      assertEq(at("hanne-timer", "2026-10-14T22:30:00Z"), ["Mandag–Fredag"],
        "a today: at 22:30Z it is Thursday in Oslo, so only the entry for Thursday is highlighted (the server's UTC day would give Wednesday's too)");
      assertEq(at("per-periode", "2026-10-15T10:00:00Z"), ["Mandag–Fredag"],
        "a today: on a Thursday the year-round entry is highlighted, not the one that holds only in April");
      assertEq(at("stine-stengt", "2026-10-18T10:00:00Z"), ["Søndag"], "a today: a closed day is highlighted on its day (it is today, and closed)");
    }

    // ══ (b) front page ═══════════════════════════════════════════════════
    // At fixed clocks: Saturday 12:00, Tuesday 00:30 and Tuesday 04:00 in Oslo.
    for (const [when, iso, kariOpen] of [
      ["Saturday 12:00", "2026-10-17T10:00:00Z", true],
      ["Tuesday 00:30, on Monday's 12:00–03:00", "2026-10-12T22:30:00Z", true],
      ["Tuesday 04:00, after closing", "2026-10-13T02:00:00Z", false],
    ] as Array<[string, string, boolean]>) {
      for (const lang of ["no", "en"] as const) {
        const r = home(lang, iso);
        assertEq(r.status, 200, `b / ${lang} ${when}: 200`);
        const href = (slug: string) => `${lang === "en" ? "/en" : ""}/produsent/${slug}`;
        const card = (slug: string): string => new RegExp(`<a href="${href(slug)}" class="pc pc-ultra">([\\s\\S]*?)</a>`).exec(r.body)?.[1] ?? "";
        const openLine = (slug: string) => card(slug).match(/<div class="pc-meta-line">🕒[\s\S]*?<\/div>/)?.[0] ?? null;
        const openNow = `<span class="pc-open-now">${lang === "en" ? "Open now" : "Åpent nå"}</span>`;
        const closed = `<span class="pc-closed">${lang === "en" ? "Closed" : "Stengt"}</span>`;
        assertTrue(!!card("kari-langnavn") && !!card("kjell-norskuke") && !!card("reko-testringen"), `b / ${lang} ${when}: the three claimed producers have ultra-rich cards`);
        assertEq(openLine("kari-langnavn"), `<div class="pc-meta-line">🕒 ${kariOpen ? openNow : closed} <span class="pc-hours">12:00–03:00</span></div>`,
          `b / ${lang} ${when}: "monday"…"sunday" 12:00–03:00 is ${kariOpen ? "open now (main: \"Stengt\")" : "closed"}`);
        assertEq(openLine("kjell-norskuke"), `<div class="pc-meta-line">🕒 ${openNow} <span class="pc-hours">00:00–24:00</span></div>`,
          `b / ${lang} ${when}: a Norwegian range "Mandag-Søndag" from {day, hours} is open now (main: "Stengt")`);
        assertEq(openLine("reko-testringen"), null, `b / ${lang} ${when}: only "Varierer" says nothing about the day, so no open-now line (main: "Stengt")`);
        assertEq(junk(r.body), [], `b / ${lang} ${when}: no junk text`);
      }
    }
    {
      // isOpenNow at a fixed time: Kringler Gjestegård's hours (live 2026-10-17), Saturday 12:00 in Oslo.
      const kringler = ["monday", "tuesday", "wednesday", "thursday", "friday"].map((day) => ({ day, open: "10:00", close: "17:00" }))
        .concat([{ day: "saturday", open: "10:00", close: "15:00" }]);
      assertEq(seo.isOpenNow(kringler, new Date("2026-10-17T10:00:00Z")), { isOpen: true, todayLabel: "10:00–15:00" },
        "b isOpenNow: Kringler on Saturday 12:00 is open (main: \"Stengt\")");
      assertEq(seo.isOpenNow(kringler, new Date("2026-10-18T10:00:00Z")), { isOpen: false }, "b isOpenNow: Kringler on Sunday is closed");
      assertEq(seo.isOpenNow([{ day: "mon", open: "10:00", close: "17:00" }], new Date("2026-10-12T09:00:00Z")), { isOpen: true, todayLabel: "10:00–17:00" },
        "b isOpenNow: the declared form as before (Monday 11:00)");
      assertEq([seo.isOpenNow("Man–fre 10–17"), seo.isOpenNow(null), seo.isOpenNow([])], [null, null, null],
        "b isOpenNow: free text, nothing and an empty list give no line, as before");
      // Hours past midnight (live 2026-10-17): the review's cases.
      const tromso = ["mon", "tue", "wed", "thu"].map((day) => ({ day, open: "12:00", close: "01:30" }))
        .concat([{ day: "fri", open: "12:00", close: "03:00" }, { day: "sat", open: "12:00", close: "03:00" }, { day: "sun", open: "18:00", close: "01:30" }]);
      const trondhjem = [{ day: "thu", open: "15:00", close: "23:00" }, { day: "fri", open: "14:00", close: "01:00" }, { day: "sat", open: "12:00", close: "01:00" }];
      assertEq(seo.isOpenNow(tromso, new Date("2026-10-12T17:30:00Z")), { isOpen: true, todayLabel: "12:00–01:30" },
        "b isOpenNow: Tromsø Mikrobryggeri on Monday 19:30 is open (head before: \"Stengt 12:00–01:30\")");
      assertEq(seo.isOpenNow(tromso, new Date("2026-10-12T22:30:00Z")), { isOpen: true, todayLabel: "12:00–01:30" },
        "b isOpenNow: Tromsø on Tuesday 00:30 is open, on Monday's entry");
      assertEq(seo.isOpenNow(tromso, new Date("2026-10-13T00:00:00Z")), { isOpen: false, todayLabel: "12:00–01:30" },
        "b isOpenNow: Tromsø on Tuesday 02:00 is closed");
      assertEq(seo.isOpenNow(trondhjem, new Date("2026-10-16T22:30:00Z")), { isOpen: true, todayLabel: "14:00–01:00" },
        "b isOpenNow: Trondhjem Mikrobryggeri on Saturday 00:30 is open, on Friday's entry");
    }

    // ══ (c) lokal_info and the A2A auto-reply agree ══════════════════════
    {
      const mcp = require("./mcp") as typeof import("./mcp");
      const tools = new Map<string, CapturedTool>();
      const fakeServer: any = {
        registerTool(name: string, config: any, handler: any) { tools.set(name, { config, handler }); },
        resource() { /* no-op */ }, prompt() { /* no-op */ }, registerResource() { /* no-op */ }, registerPrompt() { /* no-op */ },
      };
      mcp.registerTools(fakeServer, () => "test-client", () => undefined);
      const info = tools.get("lokal_info")!;
      const { conversationService } = require("../services/conversation-service") as typeof import("../services/conversation-service");
      const expected: Record<string, string> = {
        "hanne-timer": "Man: Stengt, Tir–Ons 10:00–16:00, Man–Fre 10:00–19:00, Lør 11:00–18:00",
        "frode-fratil": "Påske 12:00–18:00, Fre–lør (sesong) 12:00–20:00",
        "nora-notat": "Åpent etter avtale — ring eller send SMS, 1. juli - 31. juli: Mandag-søndag 09:00-16:00, Selvbetjent <bod> & kjøleskap",
        "per-periode": "Tor–Fre 12:00–16:00 (April), Man–Fre 08:00–18:00",
        "rita-rekkevidde": "Man–Søn 00:00–24:00",
        "stine-stengt": "Søn: Stengt, Tir 12.00–18.00, Lør 10–17, Fre 9:00–17:30, Tor 18:00–01:30",
        // I-J (main: no hours line for either).
        "hovdneset-gard-rena": "Fre 12:00–17:00 (1.7.–31.10.2026)",
        "sma-vesen": "Etter avtale; Utsalet i bryggeriet er ope på førespurnad – ring 476 82 708. Elles når det er annonsert på Facebook. Sjølvbetening frå kjøleskåp utanfor døra (alkoholfri drikke og ølglas), betal med Vipps.",
        "siri-skjema": "Lør–Søn 10:00–15:00, Man 9–14.30 (1.11.2026–31.3.2027), Ons 10:00–14:00 (fra 1.7.2026), PublicHolidays 12:00–15:00, Tor 10:00–17:00",
      };
      for (const p of Object.values(P)) {
        console.log = () => {};
        let mcpText = "";
        let replyText = "";
        try {
          const r = await info.handler({ agentId: p.id });
          mcpText = String(r?.content?.[0]?.text ?? "");
          replyText = conversationService.generateSellerResponse(p.id)?.text ?? "";
        } finally { console.log = origLog; }
        const mcpHours = /\n## Åpningstider\n(.*)\n/.exec(mcpText)?.[1] ?? null;
        const replyHours = /\n🕐 Åpningstider: (.*)\n/.exec(replyText)?.[1] ?? null;
        assertEq(mcpHours, expected[p.slug], `c ${p.slug}: lokal_info shows the hours (main: left out)`);
        assertEq(replyHours, mcpHours, `c ${p.slug}: the A2A auto-reply shows the same hours as lokal_info`);
        const pageTimes = [...(hoursGrid(pages[p.slug]!.no) ?? "").matchAll(/(\d{2}:\d{2}) – (\d{2}:\d{2})/g)].map((m) => `${m[1]}–${m[2]}`);
        assertTrue(pageTimes.every((t) => (mcpHours ?? "").includes(t)),
          `c ${p.slug}: every time on the page is in lokal_info's hours`);
      }
    }

    // ══ (d) /agents/:id/agent.json is seed-store only; nothing links it ══
    {
      const root = path.resolve(__dirname, "..");
      const offenders: string[] = [];
      for (const file of sourceFiles(root)) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!/\/agents\/[^\s"'`]*\/agent\.json/.test(line)) return;
          const trimmed = line.trim();
          const isA2aRoute = file.endsWith(path.join("routes", "a2a.ts")) && (trimmed.startsWith("//") || trimmed.startsWith('router.get("/agents/:id/agent.json"'));
          if (!isA2aRoute) offenders.push(`${path.relative(root, file)}:${i + 1}: ${trimmed.slice(0, 120)}`);
        });
      }
      assertEq(offenders, [], "d no source file outside a2a.ts's route links /agents/:id/agent.json (seed store only, 404 for marketplace producers)");
      const a2a = fs.readFileSync(path.join(root, "routes", "a2a.ts"), "utf8");
      assertTrue(a2a.includes('router.get("/agents/:id/agent.json"'), "d the route itself is still registered (behaviour unchanged)");
    }

    // ══ (e) I-J: schema.org's form and the byAppointment form ════════════
    {
      const spec = (body: string) => jsonLdBlocks(body).find((b) => b["@type"] === "LocalBusiness")?.openingHoursSpecification ?? null;
      const hov = pages["hovdneset-gard-rena"]!;
      assertEq(withoutToday(hoursGrid(hov.no) ?? ""),
        "<div class=\"hrs-day\">Fredag</div><div class=\"hrs-time\">12:00 – 17:00 (1.7.–31.10.2026; Grønnsakstor på Rena torg – sesongutsalg, juli–oktober)</div>",
        "e Hovdneset Gård: \"Fredag 12:00 – 17:00\" with the period and the note (main: no hours card)");
      assertEq(withoutToday(hoursGrid(hov.en) ?? ""),
        "<div class=\"hrs-day\">Friday</div><div class=\"hrs-time\">12:00 – 17:00 (1.7.–31.10.2026; Grønnsakstor på Rena torg – sesongutsalg, juli–oktober)</div>",
        "e Hovdneset Gård /en: \"Friday\"");
      assertEq(spec(hov.no), [{
        "@type": "OpeningHoursSpecification", dayOfWeek: "https://schema.org/Friday", opens: "12:00", closes: "17:00",
        validFrom: "2026-07-01", validThrough: "2026-10-31",
      }], "e Hovdneset Gård: JSON-LD states Friday 12:00–17:00 with its validFrom/validThrough (main: none)");
      const sma = pages["sma-vesen"]!;
      assertEq(hoursGrid(sma.no),
        "<div class=\"hrs-day\"></div><div class=\"hrs-time\">Etter avtale; Utsalet i bryggeriet er ope på førespurnad – ring 476 82 708. " +
        "Elles når det er annonsert på Facebook. Sjølvbetening frå kjøleskåp utanfor døra (alkoholfri drikke og ølglas), betal med Vipps.</div>",
        "e Små Vesen: \"Etter avtale\" and the description, as {day: by-appointment, note} is shown (main: no hours card)");
      assertEq(spec(sma.no), null, "e Små Vesen: no JSON-LD hours (no day, no times)");
      const sch = pages["siri-skjema"]!;
      assertEq(withoutToday(hoursGrid(sch.no) ?? ""),
        "<div class=\"hrs-day\">Lørdag–Søndag</div><div class=\"hrs-time\">10:00 – 15:00</div>" +
        "<div class=\"hrs-day\">Mandag</div><div class=\"hrs-time\">9 – 14.30 (1.11.2026–31.3.2027; Vintertid)</div>" +
        "<div class=\"hrs-day\">Onsdag</div><div class=\"hrs-time\">10:00 – 14:00 (fra 1.7.2026)</div>" +
        "<div class=\"hrs-day\">PublicHolidays</div><div class=\"hrs-time\">12:00 – 15:00</div>" +
        "<div class=\"hrs-day\">Torsdag</div><div class=\"hrs-time\">10:00 – 17:00</div>",
        "e schema.org's form: URIs and a list are days; validity across a new year and with one end; a DayOfWeek that is no weekday as written; the declared form as before");
      const sp = (dayOfWeek: string | string[], opens: string, closes: string, validity: object = {}) =>
        ({ "@type": "OpeningHoursSpecification", dayOfWeek, opens, closes, ...validity });
      assertEq(spec(sch.no), [
        sp(["https://schema.org/Saturday", "https://schema.org/Sunday"], "10:00", "15:00"),
        sp("https://schema.org/Monday", "09:00", "14:30", { validFrom: "2026-11-01", validThrough: "2027-03-31" }),
        sp("https://schema.org/Thursday", "10:00", "17:00"),
      ], "e schema.org's form in JSON-LD: a list, times as \"HH:MM\", validity only as two ISO dates; a period with one end and PublicHolidays are left out");
      // The "today" highlight skips an entry that holds only in a period, as I-H.
      const at = (slug: string, iso: string) => todayRows(hoursGrid(atClock(iso, () => producer(slug)).body) ?? "");
      assertEq(at("hovdneset-gard-rena", "2026-07-03T11:00:00Z"), [], "e today: Hovdneset on a Friday in its season is not highlighted (an entry with a period may not hold today)");
      assertEq(at("siri-skjema", "2026-10-17T10:00:00Z"), ["Lørdag–Søndag"], "e today: Saturday highlights the year-round Saturday–Sunday entry");
      assertEq([at("siri-skjema", "2026-11-02T10:00:00Z"), at("siri-skjema", "2026-10-14T10:00:00Z")], [[], []],
        "e today: Monday's and Wednesday's entries hold only in a period and are not highlighted");
      // Every page of the fixture: only the seven weekdays, validity only as two ISO dates in order.
      const weekdays = new Set(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d) => `https://schema.org/${d}`));
      const bad: string[] = [];
      for (const [slug, page] of Object.entries(pages)) {
        for (const lang of ["no", "en"] as const) {
          for (const s of (spec(page[lang]) ?? []) as any[]) {
            const days = Array.isArray(s.dayOfWeek) ? s.dayOfWeek : [s.dayOfWeek];
            if (!days.length || !days.every((d: unknown) => weekdays.has(String(d)))) bad.push(`${slug} ${lang}: dayOfWeek ${JSON.stringify(s.dayOfWeek)}`);
            const iso = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
            const hasValidity = "validFrom" in s || "validThrough" in s;
            if (hasValidity && !(iso(s.validFrom) && iso(s.validThrough) && s.validFrom <= s.validThrough)) bad.push(`${slug} ${lang}: validity ${s.validFrom}–${s.validThrough}`);
          }
        }
      }
      assertEq(bad, [], "e every page: JSON-LD dayOfWeek is one of the seven weekdays, and validity is two ISO dates in order");
    }
  } finally {
    console.log = origLog;
    console.error = origError;
    if (prevDb) __setDbForTesting(prevDb as any);
    __setGeocodingFetchForTesting();
    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;
    testDb.close();
  }

  return { passed, failed, failures };
}

// Standalone runner: `npx tsx src/routes/rfb-apningstider-normaliserer.test.ts`
if (require.main === module) {
  console.log("── rfb-apningstider-normaliserer (I-H, I-J: one reading of opening hours) ──");
  runRfbApningstiderNormalisererTests({ log: true }).then((r) => {
    console.log(`\nrfb-apningstider-normaliserer: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
