/**
 * dental-sted-stavemater.test.ts -- dev-request 2026-10-17-dental-d3-rettelser,
 * skive D3b punkt 1 (IDX-3: /sted samler alle stavemåter av et sted).
 *
 *   A  the /sted groups: one group per slug, its main row, its spellings
 *      (most clinics first) and their summed count; the store filter is
 *      poststed_in for several spellings and the old { poststed } for one.
 *   B  /sted/<slug> lists and counts every spelling ("BERGEN" + "Bergen"),
 *      never rejected or closed rows, never another slug (OS is not OSLO);
 *      paging over two spellings has no duplicates.
 *   C  the clinic page's «Det finnes N klinikker i X» = the /sted count, for
 *      a clinic of either spelling.
 *   D  the sitemap: one /sted URL per slug in the old order, its lastmod the
 *      newest clinic of every spelling.
 *   E  the chips: one per slug on /fylke (with the group's count) and on /.
 *   F  the count runs on idx_dental_poststed; more spellings than poststed_in
 *      takes, or a spelling over its length limit, does not throw.
 *
 * Same harness as dental-indexing-hygiene.test.ts (in-memory dental DB, the
 * router driven through router.handle(), req.query filled from the URL).
 *
 * Standalone: npx tsx src/routes/dental-sted-stavemater.test.ts
 * Wired into tests/test.ts via runDentalStedStavematerTests().
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

function callRoute(router: any, url: string): Promise<RouteResult> {
  const parsed = new URL(url, "http://finn-tannlege.test");
  const query: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => { query[k] = v; });
  return new Promise((resolve) => {
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: parsed.pathname,
      params: {},
      query,
      headers: {},
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      setHeader() { return this; },
      header() { return this; },
      send(payload: any) {
        resolve({ status: this.statusCode, text: String(payload ?? "") });
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, text: JSON.stringify(payload) });
        return this;
      },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, text: String(err) });
      else resolve({ status: 404, text: "unhandled" });
    });
  });
}

const titleOf = (html: string): string | null => (html.match(/<title>([^<]*)<\/title>/) || [])[1] ?? null;
const descriptionOf = (html: string): string =>
  (html.match(/<meta name="description" content="([^"]*)">/) || [])[1] ?? "";
const stedCount = (html: string): number | null => {
  const m = html.match(/([\d\s  ]+) klinikker registrert/);
  return m ? Number(m[1]!.replace(/\D/g, "")) : null;
};
const sokCount = (html: string): number | null => {
  const m = html.match(/([\d\s  ]+) klinikker funnet/);
  return m ? Number(m[1]!.replace(/\D/g, "")) : null;
};
/** The clinic names on the rendered cards, in order. */
const cardNames = (html: string): string[] =>
  Array.from(html.matchAll(/<div class="clinic-name"><a href="[^"]*">([^<]*)<\/a>/g), (m) => m[1]!);
/** Every /sted href in a page section (from `start` to the next `end`). */
function stedHrefsIn(html: string, start: string, end: string): string[] {
  const at = html.indexOf(start);
  if (at < 0) return [];
  const section = html.slice(at, html.indexOf(end, at + start.length));
  return Array.from(section.matchAll(/href="(\/sted\/[^"]*)"/g), (m) => m[1]!);
}
/** <loc> -> <lastmod> (null when the URL has none), in sitemap order. */
function sitemapEntries(xml: string): Array<[string, string | null]> {
  return Array.from(xml.matchAll(/<url>(.*?)<\/url>/g), (m) => [
    (m[1]!.match(/<loc>([^<]*)<\/loc>/) || [])[1]!,
    (m[1]!.match(/<lastmod>([^<]*)<\/lastmod>/) || [])[1] ?? null,
  ]);
}

export async function runDentalStedStavematerTests(
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
    require.resolve("../services/dental-store"),
    require.resolve("./dental-seo"),
  ];
  const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(cachePaths);

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const db = dbFactory.getDb("dental");
    const store = require("../services/dental-store") as typeof import("../services/dental-store");
    const dentalSeo = require("./dental-seo") as typeof import("./dental-seo");
    const { __resetDentalSearchGazetteerForTesting } = require("../services/dental-search-gazetteer") as typeof import("../services/dental-search-gazetteer");
    const { MAX_POSTSTED_IN } = require("../services/dental-query-parser") as typeof import("../services/dental-query-parser");
    const router = dentalSeo.default as any;
    const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";
    // The poststed cache is shared with other blocks; start from this DB.
    __resetDentalSearchGazetteerForTesting();
    dentalSeo.__resetDentalSitemapCacheForTesting();

    // ── fixture ──────────────────────────────────────────────────────────
    // Bergen: BERGEN×3 and Bergen×2 (one of them an offentlig_klinikk row,
    // and the newest), plus a rejected and a closed Bergen dated later still.
    // Ål: ÅL×2 and Aal×1. OSLO×4 and OS×2 (two slugs). Molde: MOLDE×30 and
    // Molde×25, which is two pages only when both spellings are counted.
    let orgSeq = 918990000;
    type Extra = { updatedAt?: string; rejected?: boolean; inactive?: boolean; klass?: string };
    const mk = (navn: string, poststed: string, fylke: string, x: Extra = {}): { id: string; navn: string; slug: string } => {
      const org_nr = String(++orgSeq);
      const id = store.createDentalAgent({ navn, org_nr, poststed, fylke, adresse: "Storgata 1", telefon: "22110099" } as any);
      db.prepare(
        "UPDATE dental_agents SET catalog_class = ?, is_inactive = ?, verification_status = ?, updated_at = COALESCE(?, updated_at) WHERE id = ?"
      ).run(x.klass ?? "klinikk", x.inactive ? 1 : 0, x.rejected ? "rejected" : "unverified", x.updatedAt ?? null, id);
      return { id, navn, slug: dentalSeo.slugifyClinic(navn, org_nr) };
    };
    const bergenUpper = [
      mk("Bryggen Tann AS", "BERGEN", "Vestland", { updatedAt: "2026-03-01 10:00:00" }),
      mk("Nordnes Tann AS", "BERGEN", "Vestland", { updatedAt: "2026-04-10 10:00:00" }),
      mk("Sandviken Tann AS", "BERGEN", "Vestland", { updatedAt: "2026-02-01 10:00:00" }),
    ];
    const bergenLower = [
      mk("Fana Tann AS", "Bergen", "Vestland", { updatedAt: "2026-01-15 10:00:00" }),
      mk("Laksevaag Tannhelse", "Bergen", "Vestland", { updatedAt: "2026-06-15 10:00:00", klass: "offentlig_klinikk" }),
    ];
    const bergenRejected = mk("Avvist Bergen Tann AS", "Bergen", "Vestland", { updatedAt: "2026-09-01 10:00:00", rejected: true });
    const bergenClosed = mk("Nedlagt Bergen Tann AS", "BERGEN", "Vestland", { updatedAt: "2026-09-02 10:00:00", inactive: true });
    mk("Hallingdal Tann AS", "ÅL", "Buskerud", { updatedAt: "2026-05-01 10:00:00" });
    mk("Sentrum Tann Ål AS", "ÅL", "Buskerud", { updatedAt: "2026-05-02 10:00:00" });
    const aalClinic = mk("Aal Tannklinikk AS", "Aal", "Buskerud", { updatedAt: "2026-05-03 10:00:00" });
    for (let i = 1; i <= 4; i++) mk(`Oslo Tann ${i} AS`, "OSLO", "Oslo", { updatedAt: `2026-04-0${i} 10:00:00` });
    for (let i = 1; i <= 2; i++) mk(`Os Tann ${i} AS`, "OS", "Vestland", { updatedAt: `2026-08-0${i} 10:00:00` });
    for (let i = 1; i <= 30; i++) mk(`Molde Tann ${String(i).padStart(2, "0")} AS`, "MOLDE", "Møre og Romsdal", { updatedAt: "2026-03-10 10:00:00" });
    for (let i = 1; i <= 25; i++) mk(`Molde Klinikk ${String(i).padStart(2, "0")} AS`, "Molde", "Møre og Romsdal", { updatedAt: "2026-03-11 10:00:00" });
    const bergenNames = [...bergenUpper, ...bergenLower].map((c) => c.navn).sort();

    // ── A. the groups and their filter ───────────────────────────────────
    {
      const bergen = dentalSeo.findStedGroup("bergen");
      assertEq(bergen && { row: bergen.row, spellings: bergen.spellings, count: bergen.count },
        { row: { poststed: "BERGEN", fylke: "Vestland", count: 3 }, spellings: ["BERGEN", "Bergen"], count: 5 },
        "A1: /sted/bergen group: the BERGEN row, both spellings most clinics first, count 5");
      assertEq(dentalSeo.stedFilter(bergen!), { poststed_in: ["BERGEN", "Bergen"] }, "A2: several spellings -> poststed_in with all of them");
      const aal = dentalSeo.findStedGroup("aal");
      assertEq(aal && [aal.row.poststed, aal.spellings, aal.count], ["ÅL", ["ÅL", "Aal"], 3], "A3: /sted/aal group: ÅL and Aal (slugifyText folds å to aa), count 3");
      const oslo = dentalSeo.findStedGroup("oslo");
      assertEq(oslo && [oslo.spellings, oslo.count], [["OSLO"], 4], "A4: /sted/oslo has one spelling");
      assertEq(dentalSeo.stedFilter(oslo!), { poststed: "OSLO" }, "A5: one spelling -> the old { poststed } filter, so its SQL is unchanged");
      assertEq(dentalSeo.findStedGroup("os")?.spellings, ["OS"], "A6: OS is its own group, not merged into OSLO");
      assertEq(dentalSeo.findStedGroup("finnes-ikke"), undefined, "A7: unknown slug -> no group");
    }

    // ── B. /sted/<slug> ──────────────────────────────────────────────────
    {
      const bergen = await callRoute(router, "/sted/bergen");
      assertEq(bergen.status, 200, "B1: GET /sted/bergen -> 200");
      assertEq(stedCount(bergen.text), 5, "B2: /sted/bergen shows 5 = BERGEN 3 + Bergen 2 (regression: 3, the BERGEN row only)");
      assertEq(cardNames(bergen.text).sort(), bergenNames, "B3: /sted/bergen lists the clinics of both spellings");
      assertTrue(!bergen.text.includes(bergenRejected.navn) && !bergen.text.includes(bergenClosed.navn), "B4: the rejected and the closed Bergen clinic are left out");
      assertTrue(bergen.text.includes("Side 1 av 1"), "B5: one page");
      assertEq(titleOf(bergen.text), "Tannlege i Bergen — Finn-tannlege.com", "B6: title from the main row, as before");
      assertTrue(descriptionOf(bergen.text).startsWith("Oversikt over 5 tannlegeklinikker i Bergen, Vestland."), "B7: description gives the same 5");

      const aal = await callRoute(router, "/sted/aal");
      assertEq([aal.status, stedCount(aal.text)], [200, 3], "B8: /sted/aal shows 3 = ÅL 2 + Aal 1");
      assertEq(titleOf(aal.text), "Tannlege i Ål — Finn-tannlege.com", "B9: /sted/aal is titled from the ÅL row");

      assertEq(stedCount((await callRoute(router, "/sted/oslo")).text), 4, "B10: /sted/oslo still 4 (OS is not counted)");
      assertEq(stedCount((await callRoute(router, "/sted/os")).text), 2, "B11: /sted/os still 2 (OSLO is not counted)");

      // Two spellings across two pages: every clinic once.
      const p1 = await callRoute(router, "/sted/molde");
      const p2 = await callRoute(router, "/sted/molde?side=2");
      assertEq(stedCount(p1.text), 55, "B12: /sted/molde shows 55 = MOLDE 30 + Molde 25");
      assertTrue(p1.text.includes("Side 1 av 2") && p2.text.includes("Side 2 av 2"), "B13: two pages (regression: 30 clinics, one page)");
      const a = cardNames(p1.text);
      const b = cardNames(p2.text);
      assertEq([a.length, b.length], [50, 5], "B14: 50 cards on page 1 and 5 on page 2");
      assertEq([new Set([...a, ...b]).size, b.filter((n) => a.includes(n))], [55, []], "B15: paging gives every clinic once, no duplicates");
      assertTrue(a.some((n) => n.startsWith("Molde Tann")) && [...a, ...b].some((n) => n.startsWith("Molde Klinikk")), "B16: both spellings are listed");

      // Negative control: /sok reads «Bergen» as before.
      const sok = await callRoute(router, "/sok?q=Bergen");
      assertEq(sokCount(sok.text), 5, "B17: /sok?q=Bergen unchanged (5)");
      assertEq(cardNames(sok.text).sort(), bergenNames, "B18: /sok?q=Bergen and /sted/bergen list the same clinics");
    }

    // ── C. «Det finnes N klinikker i X» on the clinic page ───────────────
    {
      const finnes = (html: string): string | null => (descriptionOf(html).match(/Det finnes \d+ klinikker i [^.]+\./) || [])[0] ?? null;
      for (const c of [bergenUpper[0]!, bergenLower[1]!]) {
        const page = await callRoute(router, `/klinikk/${c.slug}`);
        assertEq([page.status, finnes(page.text)], [200, "Det finnes 5 klinikker i Bergen."], `C1: ${c.navn} (${c === bergenUpper[0] ? "BERGEN" : "Bergen, offentlig_klinikk"}) gives the /sted/bergen count`);
      }
      const aalPage = await callRoute(router, `/klinikk/${aalClinic.slug}`);
      // The place is named in its official spelling since D3d trinn 3 (was «i Aal.»).
      assertEq(finnes(aalPage.text), "Det finnes 3 klinikker i Ål.", "C2: an Aal clinic gives the /sted/aal count (3), named Ål");
    }

    // ── D. the sitemap ───────────────────────────────────────────────────
    {
      dentalSeo.__resetDentalSitemapCacheForTesting();
      const sm = await callRoute(router, "/sitemap.xml");
      assertEq(sm.status, 200, "D1: GET /sitemap.xml -> 200");
      const entries = sitemapEntries(sm.text);
      const sted = entries.filter(([loc]) => loc.startsWith(`${base}/sted/`));
      const lastmodOf = (slug: string): Array<string | null> => sted.filter(([loc]) => loc === `${base}/sted/${slug}`).map(([, d]) => d);
      assertEq(lastmodOf("bergen"), ["2026-06-15"], "D2: /sted/bergen listed once, lastmod = the newest Bergen clinic (regression: 2026-04-10, BERGEN only)");
      assertEq(lastmodOf("aal"), ["2026-05-03"], "D3: /sted/aal listed once, lastmod = the Aal row (regression: 2026-05-02)");
      assertEq(lastmodOf("oslo"), ["2026-04-04"], "D4: /sted/oslo unchanged");
      assertEq(lastmodOf("molde"), ["2026-03-11"], "D5: /sted/molde: the newer spelling's day");
      const slugsInListOrder = [...new Set(store.listPoststeder(1).map((p) => dentalSeo.slugifyText(p.poststed)))];
      assertEq(sted.map(([loc]) => loc.slice(`${base}/sted/`.length)), slugsInListOrder, "D6: one /sted URL per slug, in the poststed list's order (same set and order as before)");
    }

    // ── E. chips ─────────────────────────────────────────────────────────
    {
      const vestland = await callRoute(router, "/fylke/Vestland");
      const chips = (html: string): string[] =>
        Array.from(html.matchAll(/<a href="(\/sted\/[^"]*)" class="spec-chip">([^<]*) <span[^>]*>\((\d+)\)<\/span><\/a>/g), (m) => `${m[1]} ${m[2]} (${m[3]})`);
      assertEq(chips(vestland.text), ["/sted/bergen Bergen (5)", "/sted/os Os (2)"], "E1: /fylke/Vestland: one Bergen chip with 5 (regression: BERGEN (3) and Bergen (2))");
      assertEq((vestland.text.match(/href="\/sted\/bergen"/g) || []).length, 1, "E2: /fylke/Vestland has exactly one href=\"/sted/bergen\"");
      assertEq(chips((await callRoute(router, "/fylke/Buskerud")).text), ["/sted/aal Ål (3)"], "E3: /fylke/Buskerud: one Ål chip with 3");
      for (const f of ["Oslo", "Vestland", "Buskerud", "Møre og Romsdal"]) {
        const hrefs = chips((await callRoute(router, `/fylke/${encodeURIComponent(f)}`)).text).map((c) => c.split(" ")[0]!);
        assertEq(hrefs.length, new Set(hrefs).size, `E4: /fylke/${f}: no slug in two chips`);
      }

      const home = await callRoute(router, "/");
      const popular = stedHrefsIn(home.text, "Populære steder", "</section>");
      assertEq(popular, ["/sted/molde", "/sted/bergen", "/sted/oslo", "/sted/aal", "/sted/os"], "E5: «Populære steder» on /: one chip per slug, largest group first (regression: molde, bergen and aal twice)");
      assertEq(popular.length, new Set(popular).size, "E6: the «Populære steder» hrefs are unique");
    }

    // ── F. index use and the poststed_in limits ──────────────────────────
    {
      const bergenFilter = dentalSeo.stedFilter(dentalSeo.findStedGroup("bergen")!);
      const { where, params } = store.buildDentalWhere(store.ListFilterSchema.parse(bergenFilter), { publicOnly: true });
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM dental_agents WHERE ${where.join(" AND ")}`).all(params) as Array<{ detail: string }>;
      assertTrue(plan.some((p) => /idx_dental_poststed/.test(p.detail)), `F1: the /sted/bergen count uses idx_dental_poststed (${plan.map((p) => p.detail).join("; ")})`);

      // More spellings than poststed_in takes, and spellings past its length
      // limit, added after the first build: the page must still render.
      const cases = (word: string, n: number): string[] =>
        Array.from({ length: n }, (_, i) => [...word].map((ch, j) => ((i >> j) & 1 ? ch.toUpperCase() : ch)).join(""));
      const many = cases("stedx", MAX_POSTSTED_IN + 2);
      const manyClinics = many.map((spelling, i) => mk(`Mange Stavemaater ${i} AS`, spelling, "Finnmark"));
      const long = "Langt Stedsnavn ".repeat(7).trim();
      mk("Langt Navn En AS", long.toUpperCase(), "Finnmark");
      mk("Langt Navn To AS", long, "Finnmark");
      __resetDentalSearchGazetteerForTesting();
      dentalSeo.__resetDentalSitemapCacheForTesting();
      assertEq([dentalSeo.findStedGroup("stedx")?.spellings.length, long.length > 100], [MAX_POSTSTED_IN + 2, true], "F2: fixture sanity — 22 spellings of stedx, a name over 100 characters");
      const stedx = await callRoute(router, "/sted/stedx");
      assertEq([stedx.status, stedCount(stedx.text)], [200, MAX_POSTSTED_IN], `F3: /sted/stedx with ${MAX_POSTSTED_IN + 2} spellings renders, with the ${MAX_POSTSTED_IN} largest`);
      const longSlug = dentalSeo.slugifyText(long);
      const longPage = await callRoute(router, `/sted/${longSlug}`);
      assertTrue(longPage.status === 200 && (stedCount(longPage.text) ?? 0) >= 1, "F4: a place whose spellings are over 100 characters renders");
      const sm = await callRoute(router, "/sitemap.xml");
      const locs = sitemapEntries(sm.text).map(([loc]) => loc);
      assertTrue(sm.status === 200 && locs.filter((l) => l === `${base}/sted/stedx`).length === 1 && locs.filter((l) => l === `${base}/sted/${longSlug}`).length === 1, "F5: the sitemap still builds and lists each of them once");
      const clinic = await callRoute(router, `/klinikk/${manyClinics[0]!.slug}`);
      assertEq(clinic.status, 200, "F6: a clinic page in that place renders");
      assertTrue(cardNames((await callRoute(router, "/sted/bergen")).text).length === 5, "F7: /sted/bergen unchanged after the cache rebuild");
    }
  } catch (err: any) {
    failed++;
    failures.push("dental /sted stavemåter: unexpected error: " + String(err?.stack || err?.message || err));
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
  runDentalStedStavematerTests({ log: true }).then((r) => {
    console.log(`\ndental /sted stavemåter (D3b): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
