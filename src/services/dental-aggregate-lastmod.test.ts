/**
 * dental-aggregate-lastmod.test.ts -- dev-request
 * 2026-10-16-finn-tannlege-landingssider, skive F1-S2 (ekte lastmod for
 * aggregatsider i sitemapen).
 *
 *   A  getDentalAggregateLastmods(): the newest updated_at day per poststed,
 *      fylke and specialty, and over all rows, from public rows only (a
 *      closed, rejected, non-clinic or probe row, or a junk date, changes
 *      nothing); the lookups match the same rows the list filters do.
 *      forPoststed takes every spelling a /sted page lists (dev-request
 *      2026-10-17-dental-d3-rettelser, D3b).
 *   B  the sitemap: /sted, /fylke, /spesialitet and / carry those days;
 *      static pages carry their text date from DENTAL_STATIC_PAGE_DATES,
 *      never the build day; no known day = no <lastmod>; one /sted URL per
 *      slug (IDX-3), dated by all its spellings (D3b); every <url> has its
 *      children in the order the sitemaps.org 0.9 XSD requires (D3b).
 *   C  parity: every aggregate lastmod in the sitemap = the newest updated_at
 *      among the clinics listPublicDentalAgents() returns for that page.
 *   D  the number of today's dates = the entities that changed today.
 *   E  cost: the aggregate on 6,900 rows stays far below the sitemap slow-log.
 *   F  the fallback branch (no sitemap rows) leaves /klinikk <lastmod> out,
 *      in the same XSD order (D3b).
 *
 * Same harness as routes/dental-seo-lastmod-antall-404-agents-txt.test.ts.
 *
 * Standalone: npx tsx src/services/dental-aggregate-lastmod.test.ts
 * Wired into tests/test.ts via runDentalAggregateLastmodTests().
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

function callRoute(router: any, urlPath: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const req: any = {
      method: "GET", url: urlPath, originalUrl: urlPath, path: urlPath,
      params: {}, query: {}, headers: {}, get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, text: String(payload ?? "") }); return this; },
      json(payload: any) { resolve({ status: this.statusCode, text: JSON.stringify(payload) }); return this; },
    };
    router.handle(req, res, (err?: any) => resolve({ status: err ? 500 : 404, text: String(err ?? "unhandled") }));
  });
}

// One <url> as the sitemaps.org 0.9 XSD has it: loc, then lastmod (optional),
// changefreq and priority, in that order and nothing else (D3b).
const XSD_URL = /^<loc>[^<]+<\/loc>(<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>)?<changefreq>(always|hourly|daily|weekly|monthly|yearly|never)<\/changefreq><priority>(0(\.\d+)?|1(\.0+)?)<\/priority>$/;
/** The inner XML of every <url> in the sitemap. */
const urlBlocks = (xml: string): string[] => Array.from(xml.matchAll(/<url>(.*?)<\/url>/g), (m) => m[1]!);

/** <loc> -> <lastmod> (null when the URL has none), for every URL in the sitemap. */
function sitemapEntries(xml: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const m of xml.matchAll(/<url>(.*?)<\/url>/g)) {
    const loc = (m[1]!.match(/<loc>([^<]*)<\/loc>/) || [])[1]!;
    out.set(loc, (m[1]!.match(/<lastmod>([^<]*)<\/lastmod>/) || [])[1] ?? null);
  }
  return out;
}

export async function runDentalAggregateLastmodTests(
  opts: { log?: boolean } = {}
): Promise<TestSummary> {
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

  const cachePaths = [
    require.resolve("../database/db-factory"),
    require.resolve("./dental-store"),
    require.resolve("../routes/dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("./dental-store") as typeof import("./dental-store");
    const dentalSeo = require("../routes/dental-seo") as typeof import("../routes/dental-seo");
    const { DENTAL_STATIC_PAGE_DATES } = require("../config/dental-landing") as typeof import("../config/dental-landing");
    const router = dentalSeo.default as any;
    const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";
    const specialtyNames = dentalSeo.SPECIALTY_PAGES.map((sp) => sp.navn);
    // A static page carries its text date, which is today on the day its text
    // was written (/om, /hvordan-det-fungerer and /proveniens, F2-S1; /vilkar,
    // F2-S5). That is the page's own date, not the build day, so the "nothing
    // else is dated today" checks below leave it out.
    const isTextDay = (loc: string, day: string | null): boolean =>
      day !== null && DENTAL_STATIC_PAGE_DATES[loc.slice(base.length)] === day;

    // ── fixture ──────────────────────────────────────────────────────────
    // Two places with different dates, a second Vestland place, a second
    // spelling of Bergen and of Tromsø, and a hidden row of every kind dated
    // later than every public one. Every date is in the past, so nothing is
    // "today".
    let orgSeq = 918970000;
    type Extra = {
      updatedAt: string | null; inactive?: boolean; rejected?: boolean; klass?: string;
      specialties?: string[]; specialistTitle?: string; noOrgNr?: boolean;
    };
    const mk = (navn: string, poststed: string, fylke: string, x: Extra): { id: string; slug: string } => {
      const org_nr = String(++orgSeq);
      const id = store.createDentalAgent({ navn, org_nr, poststed, fylke, adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare(
        `UPDATE dental_agents SET catalog_class = ?, is_inactive = ?, verification_status = ?,
           available_specialties = ?, specialists = ?, org_nr = ?, updated_at = ? WHERE id = ?`
      ).run(
        x.klass ?? "klinikk", x.inactive ? 1 : 0, x.rejected ? "rejected" : "unverified",
        x.specialties ? JSON.stringify(x.specialties) : null,
        x.specialistTitle ? JSON.stringify([{ name: "Kari Nordmann", title: x.specialistTitle }]) : null,
        x.noOrgNr ? null : org_nr, x.updatedAt, id
      );
      return { id, slug: dentalSeo.slugifyClinic(navn, org_nr) };
    };
    mk("Oslo En AS", "OSLO", "Oslo", { updatedAt: "2026-03-01 10:00:00", specialties: ["kjeveortopedi"] });
    mk("Oslo To AS", "OSLO", "Oslo", { updatedAt: "2026-05-02 08:00:00" });
    mk("Oslo Nedlagt AS", "OSLO", "Oslo", { updatedAt: "2026-09-01 09:00:00", inactive: true, specialties: ["kjeveortopedi", "endodonti"] });
    mk("Oslo Holding AS", "OSLO", "Oslo", { updatedAt: "2026-09-02 09:00:00", klass: "holding", specialties: ["periodonti"] });
    mk("Oslo Avvist AS", "OSLO", "Oslo", { updatedAt: "2026-09-03 09:00:00", rejected: true, specialties: ["pedodonti"] });
    // Public, but with no date to give: must neither be a lastmod nor hide one.
    mk("Oslo Ukjent Dato AS", "OSLO", "Oslo", { updatedAt: "ukjent", noOrgNr: true });
    mk("Oslo Uten Dato AS", "OSLO", "Oslo", { updatedAt: null, noOrgNr: true });
    // The synthetic probe row, here in OSLO with the newest date of all.
    db.prepare(
      `INSERT INTO dental_agents (id, org_nr, navn, poststed, fylke, adresse, verification_status, catalog_class, specialists, updated_at)
       VALUES ('persistence-probe-pr100b', '999999999', 'PR-100b Persistence Probe', 'OSLO', 'Oslo', 'Volume Test 1', 'needs_review', 'klinikk', ?, '2026-09-04 09:00:00')`
    ).run(JSON.stringify([{ name: "Test", title: "Kjeveortoped" }]));
    const bergen1 = mk("Bryggen Tann AS", "BERGEN", "Vestland", { updatedAt: "2026-04-10 12:00:00", specialistTitle: "Kjeveortoped" });
    const bergen2 = mk("Nordnes Tann AS", "BERGEN", "Vestland", { updatedAt: "2026-02-01T07:00:00.000Z" });
    mk("Fana Tann AS", "Bergen", "Vestland", { updatedAt: "2026-06-15 16:30:00" });
    mk("Voss Tann AS", "VOSS", "Vestland", { updatedAt: "2026-01-05 08:00:00" });
    // Tromsø: the mixed-case spelling has the most rows, so it is the row
    // /sted/tromsoe uses, and the upper-case row is the newer one: the page
    // lists both, so its day must come from the upper-case row.
    mk("Tromsø Tann AS", "Tromsø", "Troms", { updatedAt: "2026-02-10 09:00:00" });
    mk("Ishavet Tann AS", "Tromsø", "Troms", { updatedAt: "2026-03-12 09:00:00" });
    mk("Polar Tann AS", "TROMSØ", "Troms", { updatedAt: "2026-05-20 11:00:00" });

    // ── A. getDentalAggregateLastmods ────────────────────────────────────
    {
      const lm = store.getDentalAggregateLastmods({ specialties: specialtyNames });
      assertEq(lm.all, "2026-06-15", "A1: all = newest public row (hidden rows dated later are left out)");
      assertEq(lm.forPoststed(["OSLO"]), "2026-05-02", "A2: OSLO = newest public OSLO row (closed, rejected, non-clinic, probe left out)");
      assertEq(lm.forPoststed(["BERGEN"]), "2026-04-10", "A3: ['BERGEN'] = the BERGEN spelling only, as the BERGEN filter lists");
      assertEq(lm.forPoststed(["BERGEN", "Bergen"]), "2026-06-15", "A4: ['BERGEN','Bergen'] = both spellings, as /sted/bergen lists them (D3b)");
      assertEq(lm.forPoststed(["Bergen"]), "2026-06-15", "A4b: ['Bergen'] also reads its upper-case form BERGEN, as the Bergen filter does");
      assertEq(lm.forPoststed(["VOSS"]), "2026-01-05", "A5: VOSS");
      assertEq(lm.forPoststed(["ATLANTIS"]), null, "A6: unknown poststed -> null");
      assertEq(lm.forPoststed(["ATLANTIS", "VOSS"]), "2026-01-05", "A6b: an unknown spelling next to a known one changes nothing");
      assertEq(lm.forPoststed([]), null, "A6c: no spellings -> null");
      assertEq(lm.forFylke("Oslo"), "2026-05-02", "A7: fylke Oslo");
      assertEq(lm.forFylke("Vestland"), "2026-06-15", "A8: fylke Vestland (all three places)");
      assertEq(lm.forFylke("Hordaland"), "2026-06-15", "A9: an old fylke name folds to Vestland, as the fylke filter does");
      assertEq(lm.forFylke("Finnmark"), null, "A10: fylke with no rows -> null");
      assertEq(lm.forSpecialty("kjeveortopedi"), "2026-04-10", "A11: kjeveortopedi = newest public match (title stem «Kjeveortoped» counts; closed and probe rows do not)");
      assertEq(["endodonti", "periodonti", "pedodonti"].map((s) => lm.forSpecialty(s)), [null, null, null], "A12: a specialty only hidden rows have -> null");
      assertEq(lm.forSpecialty("ikke-bedt-om"), null, "A13: a name not asked for -> null");
      assertTrue(/^\d{4}-\d{2}-\d{2}$/.test(lm.all ?? ""), "A14: days are YYYY-MM-DD (time and zone cut off)");
      assertEq(lm.forPoststed(["Tromsø"]), "2026-05-20", "A16: ['Tromsø'] = both spellings, the newer upper-case TROMSØ row included (nb-NO upper case of ø)");
      assertEq(lm.forPoststed(["TROMSØ"]), "2026-05-20", "A17: ['TROMSØ'] = the TROMSØ spelling only");
      assertEq(lm.forFylke("Troms"), "2026-05-20", "A18: fylke Troms");
      const none = store.getDentalAggregateLastmods({ specialties: [] });
      assertEq([none.all, none.forSpecialty("kjeveortopedi")], ["2026-06-15", null], "A15: no specialties asked -> no specialty days, the rest unchanged");
    }

    // ── B. the sitemap ───────────────────────────────────────────────────
    dentalSeo.__resetDentalSitemapCacheForTesting();
    let entries = sitemapEntries((await callRoute(router, "/sitemap.xml")).text);
    {
      const today = new Date().toISOString().slice(0, 10);
      assertEq(entries.get(`${base}/sted/oslo`), "2026-05-02", "B1: /sted/oslo lastmod = newest public OSLO clinic (regression: was today)");
      assertEq(entries.get(`${base}/sted/bergen`), "2026-06-15", "B2: /sted/bergen lastmod = the newest of both spellings the page lists (D3b; regression: 2026-04-10, BERGEN only)");
      assertEq(entries.get(`${base}/sted/voss`), "2026-01-05", "B3: /sted/voss");
      assertEq(store.listPoststeder(1).find((p) => dentalSeo.slugifyText(p.poststed) === "tromsoe")?.poststed, "Tromsø", "B3b: fixture sanity — /sted/tromsoe uses the mixed-case row");
      assertEq(entries.get(`${base}/sted/tromsoe`), "2026-05-20", "B3c: /sted/tromsoe lastmod = the newer TROMSØ row the page also lists");
      assertEq(entries.get(`${base}/fylke/Oslo`), "2026-05-02", "B4: /fylke/Oslo (regression: was today)");
      assertEq(entries.get(`${base}/fylke/Vestland`), "2026-06-15", "B5: /fylke/Vestland");
      assertEq(entries.get(`${base}/spesialitet/kjeveortopedi`), "2026-04-10", "B6: /spesialitet/kjeveortopedi (regression: was today)");
      for (const sp of ["endodonti", "periodonti", "pedodonti"]) {
        assertTrue(entries.has(`${base}/spesialitet/${sp}`) && entries.get(`${base}/spesialitet/${sp}`) === null, `B7: /spesialitet/${sp} listed with no <lastmod> (no public clinic)`);
      }
      assertEq(entries.get(base), "2026-06-15", "B8: homepage lastmod = newest public clinic");
      for (const [p, d] of Object.entries(DENTAL_STATIC_PAGE_DATES)) {
        assertEq(entries.get(`${base}${p}`), d, `B9: ${p} lastmod = its text date`);
      }
      const statics = ["/hvordan-det-fungerer", "/om", "/personvern", "/vilkar", "/proveniens"];
      assertEq(statics.filter((p) => !(p in DENTAL_STATIC_PAGE_DATES)), [], "B10: every static page in the sitemap has a text date");
      assertTrue(statics.every((p) => entries.get(`${base}${p}`) !== today || DENTAL_STATIC_PAGE_DATES[p] === today), "B11: no static page has the build day, unless its text changed that day (regression: all had today)");
      assertEq([...entries].filter(([loc, v]) => v === today && !isTextDay(loc, v)).map(([loc]) => loc), [], "B12: nothing in the fixture changed today, so no URL carries today's date (a static page's own text date aside)");
      const omDay = DENTAL_STATIC_PAGE_DATES["/om"] ?? "";
      assertTrue(isTextDay(`${base}/om`, omDay) && !isTextDay(`${base}/om`, "1999-01-01") && !isTextDay(`${base}/sted/oslo`, "2026-05-02") && !isTextDay(`${base}/om`, null),
        "B12b: only a static page's own text date is exempt (not another day, not an aggregate page, not a missing date)");
      assertEq([...entries.values()].filter((v) => v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)), [], "B13: every <lastmod> is YYYY-MM-DD");
      assertTrue(!entries.has(`${base}/sted/test`), "B14: the probe's poststed is not listed");
      assertEq(entries.get(`${base}/klinikk/${bergen1.slug}`), "2026-04-10", "B15: /klinikk lastmod unchanged (updated_at day)");

      // The page's own «Sist oppdatert» and the sitemap agree for /personvern.
      const pv = await callRoute(router, "/personvern");
      const shown = (pv.text.match(/Sist oppdatert: (\d{4}-\d{2}-\d{2})/) || [])[1];
      assertEq(entries.get(`${base}/personvern`), shown, "B16: /personvern lastmod = the date the page shows");
      // … and for /vilkar (F2-S5), in both languages.
      const vk = (await callRoute(router, "/vilkar")).text;
      const vkShown = [(vk.match(/Sist oppdatert: (\d{4}-\d{2}-\d{2})/) || [])[1], (vk.match(/Last updated: (\d{4}-\d{2}-\d{2})/) || [])[1]];
      assertEq(vkShown, [entries.get(`${base}/vilkar`), entries.get(`${base}/vilkar`)], "B16b: /vilkar lastmod = the date the page shows, NO and EN");
      assertEq(entries.get(`${base}/vilkar`), DENTAL_STATIC_PAGE_DATES["/vilkar"], "B16c: … which is its DENTAL_STATIC_PAGE_DATES entry");

      // IDX-3: two spellings of one place give one /sted URL.
      const xml = (await callRoute(router, "/sitemap.xml")).text;
      assertEq((xml.match(new RegExp(`<loc>${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/sted/bergen</loc>`, "g")) || []).length, 1, "B17: /sted/bergen listed once (regression: once per spelling)");
      const locs = Array.from(xml.matchAll(/<loc>([^<]*)<\/loc>/g), (m) => m[1]!);
      assertEq(locs.length, new Set(locs).size, "B18: no URL is listed twice");

      // D3b: the XSD order loc, lastmod?, changefreq, priority in every <url>.
      const blocks = urlBlocks(xml);
      assertTrue(blocks.some((b) => b.includes("<lastmod>")) && blocks.some((b) => !b.includes("<lastmod>")), "B19a: fixture sanity — URLs with and without <lastmod>");
      assertEq(blocks.filter((b) => !XSD_URL.test(b)), [], "B19: every <url> is loc, lastmod?, changefreq, priority (regression: lastmod last)");
      assertTrue(!xml.includes("</priority><lastmod>"), "B20: no <lastmod> after <priority>");
      assertEq(blocks[0], `<loc>${base}</loc><lastmod>2026-06-15</lastmod><changefreq>daily</changefreq><priority>1.0</priority>`, "B20b: the first entry is the homepage in XSD order");
      assertEq(blocks.length, locs.length, "B20c: one <loc> per <url>");
    }

    // ── C. parity with the lists the pages render ────────────────────────
    {
      const newestOf = (rows: Array<{ updated_at?: string | null }>): string | null => {
        const days = rows.map((r) => String(r.updated_at ?? "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
        return days.length ? days[days.length - 1]! : null;
      };
      // Every stored spelling per slug, worked out here from the poststed list
      // rather than read from dental-seo: the page lists all of them (D3b).
      const spellingsPerSlug = new Map<string, string[]>();
      for (const p of store.listPoststeder(1)) {
        const slug = dentalSeo.slugifyText(p.poststed);
        spellingsPerSlug.set(slug, [...(spellingsPerSlug.get(slug) ?? []), p.poststed]);
      }
      assertEq([spellingsPerSlug.get("bergen"), spellingsPerSlug.get("tromsoe")], [["BERGEN", "Bergen"], ["Tromsø", "TROMSØ"]], "C0: fixture sanity — two slugs with two spellings");
      for (const [slug, spellings] of spellingsPerSlug) {
        const filter = spellings.length > 1 ? { poststed_in: spellings } : { poststed: spellings[0]! };
        assertEq(entries.get(`${base}/sted/${slug}`), newestOf(store.listPublicDentalAgents(filter, 500)), `C1: /sted/${slug} lastmod = newest clinic of every spelling /sted/${slug} lists (${JSON.stringify(filter)})`);
      }
      for (const f of ["Oslo", "Vestland"]) {
        assertEq(entries.get(`${base}/fylke/${f}`), newestOf(store.listPublicDentalAgents({ fylke: f }, 500)), `C2: /fylke/${f} lastmod = newest clinic it lists`);
      }
      for (const sp of dentalSeo.SPECIALTY_PAGES) {
        assertEq(entries.get(`${base}/spesialitet/${sp.slug}`), newestOf(store.listPublicDentalAgents({ specialty: sp.navn }, 500)), `C3: /spesialitet/${sp.slug} lastmod = newest clinic it lists`);
      }
      assertEq(entries.get(base), newestOf(store.listPublicDentalAgents({}, 500)), "C4: homepage lastmod = newest public clinic");
    }

    // ── D. today's dates = what changed today ────────────────────────────
    {
      db.prepare("UPDATE dental_agents SET updated_at = datetime('now') WHERE id = ?").run(bergen2.id);
      // The day the row was given, read back, so a run across UTC midnight
      // compares against the same day the sitemap sees.
      const today = (db.prepare("SELECT substr(updated_at, 1, 10) AS d FROM dental_agents WHERE id = ?").get(bergen2.id) as { d: string }).d;
      dentalSeo.__resetDentalSitemapCacheForTesting();
      entries = sitemapEntries((await callRoute(router, "/sitemap.xml")).text);
      const todays = [...entries].filter(([loc, v]) => v === today && !isTextDay(loc, v)).map(([k]) => k.slice(base.length) || "/").sort();
      assertEq(todays, ["/", "/fylke/Vestland", `/klinikk/${bergen2.slug}`, "/sted/bergen"].sort(), "D1: one clinic changed today -> exactly it and the pages that list it carry today's date (a static page's own text date aside)");
      assertEq(entries.get(`${base}/sted/oslo`), "2026-05-02", "D2: an unrelated place keeps its own date");
    }

    // ── E. cost on 6,900 rows ────────────────────────────────────────────
    {
      const insert = db.prepare(
        `INSERT INTO dental_agents (id, navn, org_nr, poststed, fylke, adresse, catalog_class, verification_status, available_specialties, specialists, updated_at)
         VALUES (@id, @navn, @org_nr, @poststed, @fylke, 'Gate 1', 'klinikk', 'unverified', @spec, @specialists, @updated_at)`
      );
      const fylker = ["Oslo", "Vestland", "Rogaland", "Trøndelag", "Nordland", "Agder"];
      db.transaction(() => {
        for (let i = 0; i < 6900; i++) {
          insert.run({
            id: `bench-${i}`, navn: `Bench Klinikk ${i} AS`, org_nr: String(920000000 + i),
            poststed: `STED ${i % 1500}`, fylke: fylker[i % fylker.length],
            spec: i % 5 === 0 ? JSON.stringify([specialtyNames[i % specialtyNames.length]]) : null,
            specialists: i % 3 === 0 ? JSON.stringify([{ name: `Person ${i}`, title: "Spesialist i periodonti" }]) : null,
            updated_at: `2026-0${1 + (i % 9)}-1${i % 10} 10:00:00`,
          });
        }
      })();
      store.getDentalAggregateLastmods({ specialties: specialtyNames }); // warm the statements
      let best = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = process.hrtime.bigint();
        store.getDentalAggregateLastmods({ specialties: specialtyNames });
        best = Math.min(best, Number(process.hrtime.bigint() - t) / 1e6);
      }
      if (log) console.log(`    getDentalAggregateLastmods on ~6,900 rows: ${best.toFixed(1)} ms (best of 3)`);
      assertTrue(best < 300, `E1: aggregate on ~6,900 rows in < 300 ms (${best.toFixed(1)} ms; sitemap slow-log is 3,000 ms)`);
      const lm = store.getDentalAggregateLastmods({ specialties: specialtyNames });
      assertEq(lm.forPoststed(["STED 7"]), "2026-08-17", "E2: bench rows aggregate correctly too");
    }

    // ── F. fallback branch: no sitemap rows -> /klinikk without <lastmod> ─
    {
      // Thin rows are left out of getDentalAgentsForSitemap(), which sends the
      // build down the listPublicDentalAgents() batch branch.
      db.prepare("DELETE FROM dental_agents WHERE id LIKE 'bench-%'").run();
      db.prepare("UPDATE dental_agents SET adresse = NULL, telefon = NULL, mobil = NULL, hjemmeside = NULL, opening_hours = NULL").run();
      assertEq(store.getDentalAgentsForSitemap().length, 0, "F1: fixture sanity — no sitemap rows (fallback branch)");
      dentalSeo.__resetDentalSitemapCacheForTesting();
      const fb = sitemapEntries((await callRoute(router, "/sitemap.xml")).text);
      const klinikk = [...fb].filter(([k]) => k.includes("/klinikk/"));
      assertTrue(klinikk.length > 0, "F2: fallback still lists the clinics with an org.nr");
      assertEq(klinikk.filter(([, v]) => v !== null), [], "F3: fallback /klinikk URLs carry no <lastmod> (regression: today)");
      const fbXml = (await callRoute(router, "/sitemap.xml")).text;
      assertEq(urlBlocks(fbXml).filter((b) => !XSD_URL.test(b)), [], "B21: the fallback branch writes every <url> in XSD order too");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental aggregate lastmod: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
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
  runDentalAggregateLastmodTests({ log: true }).then((r) => {
    console.log(`\ndental aggregate lastmod (F1-S2): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
