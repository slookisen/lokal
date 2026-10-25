/**
 * rfb-apningstider-sesong-tekstform.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-O (integration test round 2:
 * SD2-01, SD2-03/AI2-07, MCP2-03).
 *
 * On main (eb94b47f):
 *   - an entry with a season note (Bjørke Gård: Wednesday–Sunday 11–17,
 *     "Sesongåpent til ca. 20. september"; Hima Grønt: Saturday 10–14,
 *     "Åkerbutikk i sommarsesongen") went into JSON-LD as year-round
 *     OpeningHoursSpecification, counted for "open now" and the "today"
 *     highlight, and lokal_info and the A2A auto-reply left the note out;
 *   - hours stored as text in the day-and-time form (Hevd Håndverksbakeri:
 *     "Man-Fre 07-22, Lor 08-22, Son 09-18"; Alm Østre Gård: ["Fredag
 *     14:00-18:00", "Lørdag 11:00-15:00"]) had no day rows, no "today", no
 *     "open now" and no JSON-LD, and lokal_info showed "Lor"/"Son";
 *   - the A2A card (/api/marketplace/agents/:id/card) gave only the stored
 *     openingHours, in whatever form it was stored.
 *
 * Covers, on the real handlers with an in-memory DB and the stored values of
 * live data 2026-10-17:
 *   (a) producer page (no and en): the hours card, JSON-LD (none for a
 *       seasonal entry; day rows from text; only the seven weekdays and
 *       "HH:MM"), the "today" highlight at fixed clocks, the FAQ; text that
 *       is not in the form keeps its own row byte for byte; a year-round
 *       control is unchanged.
 *   (b) front page "open now" at fixed clocks: text in the form counts, a
 *       seasonal entry does not.
 *   (c) lokal_info and the auto-reply give the same hours text: the season
 *       note with its times, text as days and times.
 *   (d) GET /agents/:id/card has `openingHoursDisplay`, the rows of /info,
 *       as its last key and only when there are hours; `openingHours` is the
 *       stored value, unchanged.
 *
 * Exported runRfbApningstiderSesongTekstformTests({log}) -> TestSummary; wired
 * into tests/test.ts. Standalone: npx tsx src/routes/rfb-apningstider-sesong-tekstform.test.ts
 */

import Database from "better-sqlite3";

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

/** The grid without the "today" highlight, which depends on the weekday the test runs. */
function withoutToday(html: string): string {
  return html.replace(/ hrs-today/g, "").replace(/<span class="hrs-open"><span class="hrs-dot"><\/span> [^<]*<\/span>/g, "");
}

/** The day labels of the rows the hours card highlights as today. */
function todayRows(grid: string): string[] {
  return [...grid.matchAll(/<div class="hrs-day hrs-today">([^<]*)/g)].map((m) => m[1]!);
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
 * handlers give that instant. Date with arguments is unchanged.
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

export async function runRfbApningstiderSesongTekstformTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

    // ══ fixture: stored values from GET /api/marketplace/agents/:id/card, live 2026-10-17 ══
    function seedProducer(row: { id: string; name: string; city: string; trust?: number; claimed?: boolean; hours: unknown }): void {
      testDb.prepare(
        `INSERT INTO agents (
          id, name, description, provider, contact_email, url, role, api_key,
          categories, tags, skills, capabilities, languages, city, lat, lng,
          trust_score, is_active, is_verified, brreg_verified, discovery_count, interaction_count,
          total_interactions, created_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'producer', ?,
          '["vegetables"]', '[]', '[]', '{}', '["no"]', ?, 60.0, 10.0,
          ?, 1, 1, 0, 0, 0, 0, '2026-08-01 10:00:00', '2026-08-01 10:00:00')`,
      ).run(
        row.id, row.name, "Lokal produsent med gardsutsalg og mye godt.", row.name, `${row.id}@example.no`,
        "https://example.no", `key-${row.id}`, row.city, row.trust ?? 0.5,
      );
      testDb.prepare(
        `INSERT INTO agent_knowledge (agent_id, updated_at, created_at, enrichment_status, products, opening_hours)
         VALUES (?, '2026-08-01 10:00:00', '2026-08-01 10:00:00', 'enriched', ?, ?)`,
      ).run(row.id, JSON.stringify([{ name: "Poteter", category: "vegetables" }]), row.hours === null ? null : JSON.stringify(row.hours));
      if (row.claimed) {
        testDb.prepare(
          `INSERT INTO agent_claims (id, agent_id, claimant_name, claimant_email, status, verified_at)
           VALUES (?, ?, 'Eier', ?, 'verified', '2026-08-01 10:00:00')`,
        ).run(`claim-${row.id}`, row.id, `${row.id}-owner@example.no`);
      }
    }
    const P = {
      // SD2-01: an entry with a season note.
      bjorke: { id: "io-bjorke", name: "Bjørke Gård — Hønefoss", slug: "bjorke-gard-honefoss", city: "Hønefoss", claimed: true, trust: 0.98,
        hours: [{ days: "onsdag - søndag", hours: "11:00-17:00", note: "Sesongåpent til ca. 20. september" }] },
      hima: { id: "io-hima", name: "Hima-Grønt — Rogaland", slug: "hima-gront-rogaland", city: "Sandnes",
        hours: [{ day: "sat", open: "10:00", close: "14:00", note: "Åkerbutikk i sommarsesongen" }] },
      // SD2-03/AI2-07: text in the day-and-time form, as the whole field and as list entries.
      hevd: { id: "io-hevd", name: "Hevd Håndverksbakeri", slug: "hevd-handverksbakeri", city: "Trondheim", claimed: true, trust: 0.99,
        hours: "Man-Fre 07-22, Lor 08-22, Son 09-18" },
      almOstre: { id: "io-alm", name: "Alm Østre Gård", slug: "alm-ostre-gard", city: "Hamar",
        hours: ["Fredag 14:00-18:00", "Lørdag 11:00-15:00"] },
      // A closed day in text (Fagernes Kjøtt AS).
      fagernes: { id: "io-fagernes", name: "Fagernes Kjøtt AS", slug: "fagernes-kjott-as", city: "Fagernes",
        hours: "Man-Tor 09:00-15:30, Fre-Søn stengt" },
      // Text not in the form: shown as before (Inderøy Gårdsbryggeri).
      inderoy: { id: "io-inderoy", name: "Inderøy Gårdsbryggeri — Inderøy", slug: "inderoy-gardsbryggeri-inderoy", city: "Inderøy",
        hours: "Man-Lør 12-17 (sommer)" },
      // A list with one entry in the form and one with a qualifier (Tomtermais — Gårdsbutikk).
      tomtermais: { id: "io-tomtermais", name: "Tomtermais — Gårdsbutikk", slug: "tomtermais-gardsbutikk", city: "Drøbak",
        hours: ["Mandag–fredag 10:00–20:00", "Lørdag–søndag 10:00–17:00 (heile året)"] },
      // Year-round control: the declared form, with a note that is no season note.
      control: { id: "io-control", name: "Kari Kontroll", slug: "kari-kontroll", city: "Oslo", claimed: true, trust: 0.97,
        hours: [{ day: "mon-fri", open: "10:00", close: "17:00" }, { day: "sat", open: "10:00", close: "14:00", note: "Selvbetjent 24/7" }] },
    };
    for (const p of Object.values(P)) seedProducer(p);
    seedProducer({ id: "io-none", name: "Nils Ingen", city: "Oslo", hours: null });

    const regMod = require("../services/marketplace-registry");
    regMod.marketplaceRegistry._agentsCache = null;
    regMod.marketplaceRegistry._statsCache = null;

    delete require.cache[require.resolve("./seo")];
    const seo = require("./seo") as typeof import("./seo");
    function handlerFor(router: any, routePath: string): any {
      const layer = (router.stack as any[]).find((l: any) => l.route && l.route.path === routePath && l.route.methods?.get);
      if (!layer) throw new Error(`GET ${routePath} is not registered`);
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
    function invokeHtml(handler: any, req: any): { status: number; body: string } {
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
    const producerHandler = handlerFor(seo.default, "/produsent/:slug");
    const homeHandler = handlerFor(seo.default, "/");
    const producer = (slug: string, lang: "no" | "en" = "no") =>
      invokeHtml(producerHandler, { params: { slug }, lang, ip: "127.0.0.1", headers: {}, get: () => undefined, query: {} });
    const localBusiness = (body: string) => jsonLdBlocks(body).find((b) => b["@type"] === "LocalBusiness");
    const spec = (body: string) => localBusiness(body)?.openingHoursSpecification ?? null;
    const sp = (dayOfWeek: string | string[], opens: string, closes: string) => ({ "@type": "OpeningHoursSpecification", dayOfWeek, opens, closes });
    const sd = (...days: string[]) => days.map((d) => `https://schema.org/${d}`);
    const faqClaimsHours = (body: string) => JSON.stringify(jsonLdBlocks(body).find((b) => b["@type"] === "FAQPage") ?? {}).includes("har åpningstider oppført");
    // 2026-10-14 is a Wednesday, 2026-10-17 a Saturday; Oslo is UTC+2.
    const WEDNESDAY_NOON = "2026-10-14T10:00:00Z";
    const SATURDAY_NOON = "2026-10-17T10:00:00Z";
    const todayAt = (slug: string, iso: string) => todayRows(hoursGrid(atClock(iso, () => producer(slug)).body) ?? "");

    // ══ (a) producer page ════════════════════════════════════════════════
    const pages: Record<string, { no: string; en: string }> = {};
    for (const p of Object.values(P)) {
      const no = producer(p.slug);
      const en = producer(p.slug, "en");
      assertEq([no.status, en.status], [200, 200], `a ${p.slug}: 200 (no, en)`);
      assertTrue(faqClaimsHours(no.body), `a ${p.slug}: the FAQ says hours are listed, as before`);
      assertEq(junk(no.body).concat(junk(en.body)), [], `a ${p.slug}: no junk text (no, en)`);
      pages[p.slug] = { no: no.body, en: en.body };
    }
    // SD2-01: season notes.
    assertEq(withoutToday(hoursGrid(pages["bjorke-gard-honefoss"]!.no) ?? ""),
      "<div class=\"hrs-day\">Onsdag–Søndag</div><div class=\"hrs-time\">11:00 – 17:00 (Sesongåpent til ca. 20. september)</div>",
      "a Bjørke Gård: the card shows the days, times and season note, as before");
    assertEq(spec(pages["bjorke-gard-honefoss"]!.no), null, "a Bjørke Gård: no OpeningHoursSpecification (main: Wednesday–Sunday 11:00–17:00 all year)");
    assertEq(spec(pages["bjorke-gard-honefoss"]!.en), null, "a Bjørke Gård /en: no OpeningHoursSpecification");
    assertEq(todayAt("bjorke-gard-honefoss", WEDNESDAY_NOON), [], "a Bjørke Gård: a Wednesday is not highlighted as today (the entry may not hold; main: highlighted)");
    assertEq(withoutToday(hoursGrid(pages["hima-gront-rogaland"]!.no) ?? ""),
      "<div class=\"hrs-day\">Lørdag</div><div class=\"hrs-time\">10:00 – 14:00 (Åkerbutikk i sommarsesongen)</div>",
      "a Hima Grønt: the card as before");
    assertEq(spec(pages["hima-gront-rogaland"]!.no), null, "a Hima Grønt: no OpeningHoursSpecification (main: Saturday 10:00–14:00 all year)");
    assertEq(todayAt("hima-gront-rogaland", SATURDAY_NOON), [], "a Hima Grønt: a Saturday is not highlighted as today (main: highlighted)");
    // SD2-03/AI2-07: text in the day-and-time form.
    assertEq(withoutToday(hoursGrid(pages["hevd-handverksbakeri"]!.no) ?? ""),
      "<div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">07:00 – 22:00</div>" +
      "<div class=\"hrs-day\">Lørdag</div><div class=\"hrs-time\">08:00 – 22:00</div>" +
      "<div class=\"hrs-day\">Søndag</div><div class=\"hrs-time\">09:00 – 18:00</div>",
      "a Hevd: the text is three day rows (main: one row \"Man-Fre 07-22, Lor 08-22, Son 09-18\")");
    assertEq(withoutToday(hoursGrid(pages["hevd-handverksbakeri"]!.en) ?? ""),
      "<div class=\"hrs-day\">Monday–Friday</div><div class=\"hrs-time\">07:00 – 22:00</div>" +
      "<div class=\"hrs-day\">Saturday</div><div class=\"hrs-time\">08:00 – 22:00</div>" +
      "<div class=\"hrs-day\">Sunday</div><div class=\"hrs-time\">09:00 – 18:00</div>",
      "a Hevd /en: the days in English");
    assertEq(spec(pages["hevd-handverksbakeri"]!.no), [
      sp(sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday"), "07:00", "22:00"),
      sp(sd("Saturday")[0]!, "08:00", "22:00"),
      sp(sd("Sunday")[0]!, "09:00", "18:00"),
    ], "a Hevd: JSON-LD has the three rows (main: none)");
    assertEq(todayAt("hevd-handverksbakeri", SATURDAY_NOON), ["Lørdag"], "a Hevd: Saturday is highlighted as today (main: no rows)");
    assertEq(withoutToday(hoursGrid(pages["alm-ostre-gard"]!.no) ?? ""),
      "<div class=\"hrs-day\">Fredag</div><div class=\"hrs-time\">14:00 – 18:00</div>" +
      "<div class=\"hrs-day\">Lørdag</div><div class=\"hrs-time\">11:00 – 15:00</div>",
      "a Alm Østre: each text entry is a day row (main: two rows with an empty day and the raw text)");
    assertEq(spec(pages["alm-ostre-gard"]!.no), [sp(sd("Friday")[0]!, "14:00", "18:00"), sp(sd("Saturday")[0]!, "11:00", "15:00")],
      "a Alm Østre: JSON-LD has Friday and Saturday (main: none)");
    assertEq(todayAt("alm-ostre-gard", SATURDAY_NOON), ["Lørdag"], "a Alm Østre: Saturday is highlighted as today (main: not, though it was Saturday)");
    assertEq(withoutToday(hoursGrid(pages["fagernes-kjott-as"]!.no) ?? ""),
      "<div class=\"hrs-day\">Mandag–Torsdag</div><div class=\"hrs-time\">09:00 – 15:30</div>" +
      "<div class=\"hrs-day\">Fredag–Søndag</div><div class=\"hrs-time\">Stengt</div>",
      "a Fagernes Kjøtt: a closed day in text is the row \"Stengt\"");
    assertEq(spec(pages["fagernes-kjott-as"]!.no), [sp(sd("Monday", "Tuesday", "Wednesday", "Thursday"), "09:00", "15:30")],
      "a Fagernes Kjøtt: JSON-LD for the timed row only");
    // Text not in the form, and a list with one such entry.
    assertEq(hoursGrid(pages["inderoy-gardsbryggeri-inderoy"]!.no), "<div class=\"hrs-day\">Man-Lør 12-17 (sommer)</div>",
      "a Inderøy: text not in the form keeps its own row, byte for byte as main");
    assertEq(spec(pages["inderoy-gardsbryggeri-inderoy"]!.no), null, "a Inderøy: no JSON-LD, as main");
    assertEq(withoutToday(hoursGrid(pages["tomtermais-gardsbutikk"]!.no) ?? ""),
      "<div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">10:00 – 20:00</div>" +
      "<div class=\"hrs-day\"></div><div class=\"hrs-time\">Lørdag–søndag 10:00–17:00 (heile året)</div>",
      "a Tomtermais: the entry in the form is a day row; the one with a qualifier stays text");
    assertEq(spec(pages["tomtermais-gardsbutikk"]!.no), [sp(sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday"), "10:00", "20:00")],
      "a Tomtermais: JSON-LD for the day row only");
    // Year-round control: as main.
    assertEq(withoutToday(hoursGrid(pages["kari-kontroll"]!.no) ?? ""),
      "<div class=\"hrs-day\">Mandag–Fredag</div><div class=\"hrs-time\">10:00 – 17:00</div>" +
      "<div class=\"hrs-day\">Lørdag</div><div class=\"hrs-time\">10:00 – 14:00 (Selvbetjent 24/7)</div>",
      "a control: the card is as main");
    assertEq(spec(pages["kari-kontroll"]!.no), [sp(sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday"), "10:00", "17:00"), sp(sd("Saturday")[0]!, "10:00", "14:00")],
      "a control: JSON-LD as main (a note that is no season note keeps the entry)");
    assertEq(todayAt("kari-kontroll", SATURDAY_NOON), ["Lørdag"], "a control: Saturday is highlighted, as main");
    {
      // Every page of the fixture: only the seven weekdays and "HH:MM".
      const weekdays = new Set(sd("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"));
      const bad: string[] = [];
      for (const [slug, page] of Object.entries(pages)) {
        for (const lang of ["no", "en"] as const) {
          for (const s of (spec(page[lang]) ?? []) as any[]) {
            const days = Array.isArray(s.dayOfWeek) ? s.dayOfWeek : [s.dayOfWeek];
            if (!days.length || !days.every((d: unknown) => weekdays.has(String(d)))) bad.push(`${slug} ${lang}: dayOfWeek ${JSON.stringify(s.dayOfWeek)}`);
            if (!/^\d{2}:\d{2}$/.test(s.opens) || !/^\d{2}:\d{2}$/.test(s.closes)) bad.push(`${slug} ${lang}: ${s.opens}–${s.closes}`);
          }
        }
      }
      assertEq(bad, [], "a every page: JSON-LD dayOfWeek is one of the seven weekdays, opens/closes are \"HH:MM\"");
    }

    // ══ (b) front page "open now" ════════════════════════════════════════
    {
      const home = (lang: "no" | "en", iso: string) =>
        atClock(iso, () => invokeHtml(homeHandler, { lang, query: {}, ip: "127.0.0.1", headers: {}, get: () => undefined }));
      for (const lang of ["no", "en"] as const) {
        const openNow = `<span class="pc-open-now">${lang === "en" ? "Open now" : "Åpent nå"}</span>`;
        const closed = `<span class="pc-closed">${lang === "en" ? "Closed" : "Stengt"}</span>`;
        const href = (slug: string) => `${lang === "en" ? "/en" : ""}/produsent/${slug}`;
        for (const [when, iso, hevd, control] of [
          ["Saturday 12:00", SATURDAY_NOON, `${openNow} <span class="pc-hours">08:00–22:00</span>`, `${openNow} <span class="pc-hours">10:00–14:00</span>`],
          ["Sunday 08:30", "2026-10-18T06:30:00Z", `${closed} <span class="pc-hours">09:00–18:00</span>`, closed],
        ] as Array<[string, string, string, string]>) {
          const r = home(lang, iso);
          assertEq(r.status, 200, `b / ${lang} ${when}: 200`);
          const card = (slug: string): string => new RegExp(`<a href="${href(slug)}" class="pc pc-ultra">([\\s\\S]*?)</a>`).exec(r.body)?.[1] ?? "";
          const openLine = (slug: string) => card(slug).match(/<div class="pc-meta-line">🕒[\s\S]*?<\/div>/)?.[0] ?? null;
          assertTrue(!!card("hevd-handverksbakeri") && !!card("bjorke-gard-honefoss") && !!card("kari-kontroll"), `b / ${lang} ${when}: the three claimed producers have ultra-rich cards`);
          assertEq(openLine("hevd-handverksbakeri"), `<div class="pc-meta-line">🕒 ${hevd}</div>`, `b / ${lang} ${when}: Hevd's text hours give the open-now line (main: none)`);
          assertEq(openLine("bjorke-gard-honefoss"), null, `b / ${lang} ${when}: Bjørke Gård's seasonal entry gives no open-now line (main: a claim all year)`);
          assertEq(openLine("kari-kontroll"), `<div class="pc-meta-line">🕒 ${control}</div>`, `b / ${lang} ${when}: the year-round control as main`);
          assertEq(junk(r.body), [], `b / ${lang} ${when}: no junk text`);
        }
      }
      assertEq(seo.isOpenNow("Man-Fre 07-22, Lor 08-22, Son 09-18", new Date(SATURDAY_NOON)), { isOpen: true, todayLabel: "08:00–22:00" },
        "b isOpenNow: text in the form counts (main: null for any text)");
      assertEq([seo.isOpenNow("Man-Lør 12-17 (sommer)", new Date(SATURDAY_NOON)), seo.isOpenNow(P.bjorke.hours, new Date(WEDNESDAY_NOON)),
        seo.isOpenNow(P.hima.hours, new Date(SATURDAY_NOON))], [null, null, null],
        "b isOpenNow: text not in the form and seasonal entries give no line (main: \"Åpent nå\" for Bjørke and Hima)");
    }

    // ══ (c) lokal_info and the A2A auto-reply ════════════════════════════
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
        "bjorke-gard-honefoss": "Ons–Søn 11:00–17:00 (Sesongåpent til ca. 20. september)",
        "hima-gront-rogaland": "Lør 10:00–14:00 (Åkerbutikk i sommarsesongen)",
        "hevd-handverksbakeri": "Man–Fre 07:00–22:00, Lør 08:00–22:00, Søn 09:00–18:00",
        "alm-ostre-gard": "Fre 14:00–18:00, Lør 11:00–15:00",
        "fagernes-kjott-as": "Man–Tor 09:00–15:30, Fre–Søn: Stengt",
        "inderoy-gardsbryggeri-inderoy": "Man-Lør 12-17 (sommer)",
        "tomtermais-gardsbutikk": "Man–Fre 10:00–20:00, Lørdag–søndag 10:00–17:00 (heile året)",
        "kari-kontroll": "Man–Fre 10:00–17:00, Lør 10:00–14:00",
      };
      const before: Record<string, string> = {
        "bjorke-gard-honefoss": "Ons–Søn 11:00–17:00",
        "hima-gront-rogaland": "Lør 10:00–14:00",
        "hevd-handverksbakeri": "Man-Fre 07-22, Lor 08-22, Son 09-18",
        "alm-ostre-gard": "Fredag 14:00-18:00, Lørdag 11:00-15:00",
        "fagernes-kjott-as": "Man-Tor 09:00-15:30, Fre-Søn stengt",
        "tomtermais-gardsbutikk": "Mandag–fredag 10:00–20:00, Lørdag–søndag 10:00–17:00 (heile året)",
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
        const was = before[p.slug] ? ` (main: ${JSON.stringify(before[p.slug])})` : " (as main)";
        assertEq(mcpHours, expected[p.slug], `c ${p.slug}: lokal_info's hours${was}`);
        assertEq(replyHours, mcpHours, `c ${p.slug}: the A2A auto-reply shows the same hours as lokal_info`);
      }
    }

    // ══ (d) GET /agents/:id/card: openingHoursDisplay, as in /info ═══════
    {
      delete require.cache[require.resolve("./marketplace")];
      const marketplace = require("./marketplace") as typeof import("./marketplace");
      const callJson = (routePath: string, id: string): { status: number; body: any } => {
        const handler = handlerFor(marketplace.default, routePath);
        const res: any = { statusCode: 200, body: undefined };
        res.status = (c: number) => { res.statusCode = c; return res; };
        res.json = (b: unknown) => { res.body = b; return res; };
        res.setHeader = () => res;
        console.log = () => {};
        console.error = () => {};
        try {
          handler({ params: { id }, headers: {}, ip: "127.0.0.1", protocol: "https", get: (h: string) => (h.toLowerCase() === "host" ? "rettfrabonden.com" : undefined), query: {} }, res, () => { res.statusCode = -1; });
        } finally { console.log = origLog; console.error = origError; }
        return { status: res.statusCode, body: JSON.parse(JSON.stringify(res.body ?? null)) };
      };
      const card = (id: string) => callJson("/agents/:id/card", id);
      const info = (id: string) => callJson("/agents/:id/info", id);
      for (const p of Object.values(P)) {
        const c = card(p.id);
        const i = info(p.id);
        assertEq([c.status, i.status], [200, 200], `d ${p.slug}: card and /info answer 200`);
        assertEq(c.body.openingHours, p.hours, `d ${p.slug}: the card's openingHours is the stored value, unchanged`);
        assertEq(c.body.openingHoursDisplay, i.body.data.openingHoursDisplay, `d ${p.slug}: the card's openingHoursDisplay is /info's (main: none on the card)`);
        const keys = Object.keys(c.body);
        assertEq(keys[keys.length - 1], "openingHoursDisplay", `d ${p.slug}: openingHoursDisplay is the card's last key (every existing key keeps its place)`);
      }
      assertEq(card(P.hevd.id).body.openingHoursDisplay, [
        { days: "Mandag–Fredag", hours: "07:00 – 22:00", note: "" },
        { days: "Lørdag", hours: "08:00 – 22:00", note: "" },
        { days: "Søndag", hours: "09:00 – 18:00", note: "" },
      ], "d Hevd: the card has the day rows of the text (live 2026-10-17: only the raw string \"Man-Fre 07-22, Lor 08-22, Son 09-18\")");
      assertEq(card(P.almOstre.id).body.openingHoursDisplay, [
        { days: "Fredag", hours: "14:00 – 18:00", note: "" }, { days: "Lørdag", hours: "11:00 – 15:00", note: "" },
      ], "d Alm Østre: the card has the day rows of the list");
      assertEq(card(P.bjorke.id).body.openingHoursDisplay, [{ days: "Onsdag–Søndag", hours: "11:00 – 17:00", note: "Sesongåpent til ca. 20. september" }],
        "d Bjørke Gård: the card's row has the season note");
      assertEq(card(P.inderoy.id).body.openingHoursDisplay, [{ days: "", hours: "", note: "Man-Lør 12-17 (sommer)" }],
        "d Inderøy: text not in the form is one text row, as in /info");
      assertEq(card(P.control.id).body.openingHoursDisplay, [
        { days: "Mandag–Fredag", hours: "10:00 – 17:00", note: "" }, { days: "Lørdag", hours: "10:00 – 14:00", note: "Selvbetjent 24/7" },
      ], "d control: the rows of the declared form");
      const none = card("io-none");
      assertEq(none.status, 200, "d no hours: 200");
      assertTrue(!("openingHoursDisplay" in none.body) && !("openingHours" in none.body), "d no hours: neither openingHours nor openingHoursDisplay on the card");
      assertEq(card("io-missing").status, 404, "d unknown id: still 404");
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

// Standalone runner: `npx tsx src/routes/rfb-apningstider-sesong-tekstform.test.ts`
if (require.main === module) {
  console.log("── rfb-apningstider-sesong-tekstform (I-O: season notes, text in the day-and-time form, the A2A card) ──");
  runRfbApningstiderSesongTekstformTests({ log: true }).then((r) => {
    console.log(`\nrfb-apningstider-sesong-tekstform: ${r.passed} passed, ${r.failed} failed`);
    if (r.failed > 0) {
      console.log(r.failures.join("\n"));
      process.exit(1);
    }
    process.exit(0);
  });
}
