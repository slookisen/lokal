/**
 * dental-indexing-hygiene.test.ts -- dev-request
 * 2026-10-16-finn-tannlege-landingssider, skive F1-S1 (indekseringshygiene).
 *
 *   A  /sok is "noindex, follow" with and without q, and is not in the sitemap.
 *   B  the homepage hero chips link /sted/<slug> when the place has a /sted
 *      page, /sok?q= when it has none; the Akutt chip is unchanged.
 *   C  JSON-LD ItemList on /fylke, /sted and /spesialitet = the rendered
 *      cards (count, order, positions from the page offset).
 *   D  paginationHtml: a window of real links, every page reachable, the last
 *      page linked from page 1 (it linked 1–10 and «... N» as plain text).
 *      /sok resolves ?side= like the other lists, so a page past the last
 *      one is page 1, never an empty «side 999» (D3b).
 *   E  page N ≥ 2 of /fylke, /sted and /spesialitet is its own canonical,
 *      with its own <title> and description; page 1 keeps the bare canonical
 *      and its title; a bad or too high ?side= is page 1.
 *   F  /spesialitet/:slug is paged (it listed the first 50 only).
 *   G  every HTML 404 (all eight sendDentalNotFound paths, the catch-all
 *      included) is "noindex, follow" (I-Q) and has no canonical link and no
 *      og:url (they pointed at the homepage); other pages keep both.
 *   H  <title>, og:title and twitter:title on /sok, /fylke (and its 404) and
 *      /sted are escaped once (dev-request 2026-10-17-dental-d3-rettelser,
 *      D3b): «A&B» was «A&amp;amp;B».
 *
 * Same harness as dental-seo-lastmod-antall-404-agents-txt.test.ts
 * (in-memory dental DB, the router driven through router.handle()); this
 * callRoute also fills req.query from the URL, since ?side= is under test.
 *
 * Standalone: npx tsx src/routes/dental-indexing-hygiene.test.ts
 * Wired into tests/test.ts via runDentalIndexingHygieneTests().
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

const robotsOf = (html: string): string[] =>
  Array.from(html.matchAll(/<meta name="robots" content="([^"]*)">/g), (m) => m[1]!);
const canonicalOf = (html: string): string | null =>
  (html.match(/<link rel="canonical" href="([^"]*)">/) || [])[1] ?? null;
const ogUrlOf = (html: string): string | null =>
  (html.match(/<meta property="og:url" content="([^"]*)">/) || [])[1] ?? null;
const titleOf = (html: string): string | null => (html.match(/<title>([^<]*)<\/title>/) || [])[1] ?? null;
const descriptionOf = (html: string): string | null =>
  (html.match(/<meta name="description" content="([^"]*)">/) || [])[1] ?? null;
const unescapeAttr = (s: string): string => s.replace(/&amp;/g, "&");

function jsonLdBlocks(html: string): any[] {
  return Array.from(html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g), (m) => {
    try { return JSON.parse(m[1]!); } catch { return null; }
  });
}
const itemListOf = (html: string): any => jsonLdBlocks(html).find((b) => b && b["@type"] === "ItemList") ?? null;
/** The profile links of the rendered clinic cards, in order. */
function cardHrefs(html: string): string[] {
  return Array.from(
    html.matchAll(/<article class="clinic-card">[\s\S]*?<div class="clinic-name"><a href="([^"]*)">/g),
    (m) => unescapeAttr(m[1]!)
  );
}
const cardCount = (html: string): number => (html.match(/<article class="clinic-card">/g) || []).length;
/** Every href inside the page nav, unescaped. */
function navHrefs(html: string): string[] {
  const nav = (html.match(/<nav class="pagination"[^>]*>([\s\S]*?)<\/nav>/) || [])[1] ?? "";
  return Array.from(nav.matchAll(/<a href="([^"]*)"/g), (m) => unescapeAttr(m[1]!));
}

export async function runDentalIndexingHygieneTests(
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
    const { DENTAL_LANDING_CONFIG } = require("../config/dental-landing") as typeof import("../config/dental-landing");
    const router = dentalSeo.default as any;
    const base = process.env.DENTAL_BASE_URL || "https://finn-tannlege.com";
    const pageSize = DENTAL_LANDING_CONFIG.listPageSize;

    // ── fixture ──────────────────────────────────────────────────────────
    // OSLO: 120 public clinics (3 pages of 50), 60 of them with
    // kjeveortopedi (2 pages), plus a closed one the lists leave out.
    // BERGEN (3) and TRONDHEIM (2) have /sted pages; Stavanger has none.
    // SANKT HANS' HAUGEN has an apostrophe in its name (H4).
    let orgSeq = 918960000;
    const mk = (navn: string, poststed: string, fylke: string, extra: { inactive?: boolean; specialty?: string } = {}): string => {
      const id = store.createDentalAgent({
        navn, org_nr: String(++orgSeq), poststed, fylke, adresse: "Storgata 1", telefon: "22110099",
      } as any);
      db.prepare("UPDATE dental_agents SET catalog_class = 'klinikk', is_inactive = ?, available_specialties = ? WHERE id = ?")
        .run(extra.inactive ? 1 : 0, extra.specialty ? JSON.stringify([extra.specialty]) : null, id);
      return id;
    };
    for (let i = 1; i <= 120; i++) {
      mk(`Oslo Klinikk ${String(i).padStart(3, "0")} AS`, "OSLO", "Oslo", i <= 60 ? { specialty: "kjeveortopedi" } : {});
    }
    mk("Nedlagt Oslo Klinikk AS", "OSLO", "Oslo", { inactive: true, specialty: "kjeveortopedi" });
    for (let i = 1; i <= 3; i++) mk(`Bergen Tann ${i} AS`, "BERGEN", "Vestland");
    for (let i = 1; i <= 2; i++) mk(`Trondheim Tann ${i} AS`, "TRONDHEIM", "Trøndelag");
    mk("Haugen Tann AS", "SANKT HANS' HAUGEN", "Innlandet");

    // ── A. /sok noindex, out of the sitemap ──────────────────────────────
    {
      for (const url of ["/sok", "/sok?q=Bergen", "/sok?akutt=1", "/sok?fylke=Oslo&side=2", "/sok?q=finnes-ikke-noe-sted"]) {
        const r = await callRoute(router, url);
        assertEq(r.status, 200, `A1: GET ${url} -> 200`);
        assertEq(robotsOf(r.text), ["noindex, follow"], `A2: ${url} has exactly one robots meta, "noindex, follow"`);
      }
      const sok = await callRoute(router, "/sok?q=Bergen");
      assertEq(canonicalOf(sok.text), `${base}/sok`, "A3: /sok canonical unchanged");
      assertTrue(cardCount(sok.text) > 0, "A4: fixture sanity — /sok?q=Bergen still lists clinics (no change to results)");

      dentalSeo.__resetDentalSitemapCacheForTesting();
      const sm = await callRoute(router, "/sitemap.xml");
      assertEq(sm.status, 200, "A5: GET /sitemap.xml -> 200");
      assertTrue(!sm.text.includes(`<loc>${base}/sok</loc>`), "A6: /sok is not in the sitemap (regression: was listed, daily, 0.9)");
      assertTrue(!/<loc>[^<]*\/sok[?<]/.test(sm.text), "A7: no /sok URL of any kind in the sitemap");
      for (const p of ["", "/hvordan-det-fungerer", "/om", "/personvern", "/proveniens", "/sted/oslo", "/fylke/Oslo", "/spesialitet/kjeveortopedi"]) {
        assertTrue(sm.text.includes(`<loc>${base}${p}</loc>`), `A8: sitemap still lists ${p || "/"}`);
      }
    }

    // ── B. hero chips ────────────────────────────────────────────────────
    {
      const home = await callRoute(router, "/");
      assertEq(home.status, 200, "B1: GET / -> 200");
      const hero = (home.text.match(/<div class="chips"[^>]*>([\s\S]*?)<\/div>/) || [])[1] ?? "";
      const chips = Array.from(hero.matchAll(/<a href="([^"]*)" class="chip"[^>]*>([^<]*)<\/a>/g), (m) => [m[2]!, unescapeAttr(m[1]!)]);
      assertEq(chips, [
        ["Oslo", "/sted/oslo"],
        ["Bergen", "/sted/bergen"],
        ["Trondheim", "/sted/trondheim"],
        ["Stavanger", "/sok?q=Stavanger"],
        ["Akutt", "/sok?akutt=1"],
      ], "B2: chips link /sted/<slug> for places with a page, /sok?q= for Stavanger (no clinics), Akutt unchanged");
      assertEq(chips.map(([name]) => name), [...DENTAL_LANDING_CONFIG.heroPlaces, "Akutt"], "B2b: the place chips are DENTAL_LANDING_CONFIG.heroPlaces, in order");
      for (const p of ["/sted/oslo", "/sted/bergen", "/sted/trondheim"]) {
        const r = await callRoute(router, p);
        assertEq(r.status, 200, `B3: chip target ${p} -> 200`);
        assertEq(robotsOf(r.text), ["index, follow, max-snippet:-1, max-image-preview:large"], `B4: chip target ${p} is indexable`);
      }
      assertTrue(!/href="\/sok\?q=(Oslo|Bergen|Trondheim)"/.test(home.text), "B5: no chip still points Oslo/Bergen/Trondheim at /sok (regression)");

      // A place that gets clinics shows up once the poststed cache refreshes.
      mk("Stavanger Tann AS", "STAVANGER", "Rogaland");
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 61_000;
        const later = await callRoute(router, "/");
        assertTrue(later.text.includes(`<a href="/sted/stavanger" class="chip"`), "B6: after the cache TTL the Stavanger chip links /sted/stavanger");
        assertEq((await callRoute(router, "/sted/stavanger")).status, 200, "B7: …and that page answers 200");
      } finally {
        Date.now = realNow;
      }
    }

    // ── C. ItemList = rendered cards ─────────────────────────────────────
    {
      const pages: Array<[string, number, number]> = [
        ["/fylke/Oslo", 0, 50], ["/fylke/Oslo?side=2", 50, 50], ["/fylke/Oslo?side=3", 100, 20],
        ["/sted/oslo", 0, 50], ["/sted/oslo?side=2", 50, 50], ["/sted/oslo?side=3", 100, 20],
        ["/spesialitet/kjeveortopedi", 0, 50], ["/spesialitet/kjeveortopedi?side=2", 50, 10],
        ["/sted/bergen", 0, 3],
      ];
      for (const [url, offset, n] of pages) {
        const r = await callRoute(router, url);
        assertEq(r.status, 200, `C1: ${url} -> 200`);
        const list = itemListOf(r.text);
        const items: any[] = list?.itemListElement ?? [];
        assertEq(cardCount(r.text), n, `C2: ${url} renders ${n} cards`);
        assertEq(items.length, cardCount(r.text), `C3: ${url} ItemList has one ListItem per card (regression: capped at 25)`);
        assertEq(list?.numberOfItems, items.length, `C4: ${url} numberOfItems = itemListElement.length`);
        assertEq(items.map((it) => it.position), Array.from({ length: n }, (_, i) => offset + i + 1), `C5: ${url} positions run ${offset + 1}..${offset + n}`);
        assertEq(items.map((it) => it.url), cardHrefs(r.text).map((h) => base + h), `C6: ${url} ListItem URLs = the cards' profile links, in order`);
        assertTrue(items.every((it) => it["@type"] === "ListItem" && typeof it.name === "string" && !String(it.url).includes("?")), `C7: ${url} ListItems are named, with no query string in the URL`);
        assertEq(list?.url, canonicalOf(r.text), `C8: ${url} ItemList url = the page's canonical`);
      }
      // Helper unit: the shape the facet pages will reuse.
      const unit: any = dentalSeo.dentalItemListJsonLd("X", `${base}/x?side=2`, [{ id: "a", navn: "A", org_nr: "918000001" }, { id: "b", navn: "B", org_nr: null }], 50);
      assertEq(unit.itemListElement.map((it: any) => [it.position, it.url]), [[51, `${base}/klinikk/a--918000001`], [52, `${base}/klinikk/id/b`]], "C9: dentalItemListJsonLd: positions from offset, clinicProfileUrl links");
      assertEq([unit.numberOfItems, unit.url], [2, `${base}/x?side=2`], "C10: dentalItemListJsonLd: numberOfItems and url");
      assertEq(dentalSeo.dentalItemListJsonLd("X", "u", [], 0), { "@context": "https://schema.org", "@type": "ItemList", name: "X", url: "u", numberOfItems: 0, itemListElement: [] }, "C11: empty page -> empty ItemList, numberOfItems 0");
    }

    // ── D. paginationHtml ────────────────────────────────────────────────
    {
      const { paginationHtml, listPageHref } = dentalSeo;
      const html1 = paginationHtml(1, 25, "/fylke/Oslo");
      assertTrue(html1.includes('href="/fylke/Oslo?side=25"'), "D1: paginationHtml(1, 25) links side=25 (regression: «... 25» was plain text)");
      assertTrue(!/\.\.\.\s*\d/.test(html1) && !/<span[^>]*>\s*\d+\s*<\/span>/.test(html1), "D2: no page number outside a link");
      assertTrue(html1.includes('href="/fylke/Oslo" class="page-btn active" aria-current="page"'), "D3: page 1 links the bare path, marked aria-current");
      assertTrue(!html1.includes("side=1\""), "D4: no ?side=1 link (page 1 is the bare path)");
      assertTrue(!html1.includes('rel="prev"') && html1.includes('href="/fylke/Oslo?side=2" class="page-btn" rel="next"'), "D5: page 1 has rel=next to page 2 and no rel=prev");

      // Every page can be reached by following links from page 1.
      for (const total of [2, 7, 11, 25, 120]) {
        const pageOf = (href: string): number => {
          const m = href.match(/[?&]side=(\d+)$/);
          return m ? Number(m[1]) : 1;
        };
        const seen = new Set<number>([1]);
        const queue = [1];
        while (queue.length) {
          const p = queue.shift()!;
          for (const n of navHrefs(paginationHtml(p, total, "/fylke/Oslo")).map(pageOf)) {
            if (!seen.has(n)) { seen.add(n); queue.push(n); }
          }
        }
        assertEq(seen.size, total, `D6: all ${total} pages reachable by links from page 1`);
        for (const p of [1, Math.ceil(total / 2), total]) {
          const nav = navHrefs(paginationHtml(p, total, "/fylke/Oslo")).map(pageOf);
          assertTrue(nav.includes(total) && nav.includes(1), `D7: page ${p} of ${total} links the first and the last page`);
        }
      }
      assertTrue(navHrefs(paginationHtml(1, 25, "/fylke/Oslo")).length > 0 && navHrefs(paginationHtml(8, 25, "/fylke/Oslo")).includes("/fylke/Oslo?side=11"), "D8: side=11 is linked from page 8 (reachable)");

      const mid = paginationHtml(12, 25, "/sted/oslo");
      const shown = navHrefs(mid);
      const win = DENTAL_LANDING_CONFIG.paginationWindow;
      for (let n = 12 - win; n <= 12 + win; n++) {
        assertTrue(shown.includes(listPageHref("/sted/oslo", n)), `D9: page 12 links page ${n} (±${win})`);
      }
      assertTrue(!shown.includes("/sted/oslo?side=5") && !shown.includes("/sted/oslo?side=19"), "D10: the window is ±paginationWindow, not every page");
      assertEq((mid.match(/aria-current="page"/g) || []).length, 1, "D11: exactly one aria-current");
      assertTrue(mid.includes('href="/sted/oslo?side=11" class="page-btn" rel="prev"') && mid.includes('href="/sted/oslo?side=13" class="page-btn" rel="next"'), "D12: rel=prev/next point at the neighbours");
      assertEq((mid.match(/class="page-gap"/g) || []).length, 2, "D13: a gap mark on each side of the window");
      const last = paginationHtml(25, 25, "/sted/oslo");
      assertTrue(!last.includes('rel="next"') && last.includes('rel="prev"'), "D14: last page has rel=prev and no rel=next");
      assertEq(paginationHtml(1, 1, "/sted/oslo"), "", "D15: one page -> no nav");
      assertTrue(!paginationHtml(4, 7, "/sted/oslo").includes("page-gap"), "D16: no gap mark when every page fits in the window");

      // /sok keeps its filters in the links.
      assertTrue(paginationHtml(1, 3, "/sok?q=tann&helfo=1").includes('href="/sok?q=tann&amp;helfo=1&amp;side=2"'), "D17: a base with a query appends &side=N (escaped)");
      assertTrue(paginationHtml(2, 3, "/sok?").includes('href="/sok"') && paginationHtml(1, 3, "/sok?").includes('href="/sok?side=2"'), "D18: /sok without filters: /sok and /sok?side=N");
      assertEq([listPageHref("/fylke/Oslo", 1), listPageHref("/fylke/Oslo", 2), listPageHref("/sok?q=a", 3), listPageHref("/sok?", 1)], ["/fylke/Oslo", "/fylke/Oslo?side=2", "/sok?q=a&side=3", "/sok"], "D19: listPageHref");

      // Past the last page (/sok takes ?side= with no upper bound): no link
      // to a page that does not exist, «Forrige» to the last page.
      const past = paginationHtml(999, 3, "/sok?q=x");
      assertEq(navHrefs(past), ["/sok?q=x&side=3", "/sok?q=x", "/sok?q=x&side=2", "/sok?q=x&side=3"], "D22: paginationHtml(999, 3): Forrige -> side=3, then pages 1-3 (regression: Forrige -> side=998)");
      assertTrue(past.includes('href="/sok?q=x&amp;side=3" class="page-btn" rel="prev"') && !past.includes('rel="next"') && !past.includes("aria-current"), "D23: …rel=prev to the last page, no rel=next, no page marked current");
      assertEq(navHrefs(paginationHtml(4, 3, "/sok?q=x"))[0], "/sok?q=x&side=3", "D24: one past the last page: Forrige -> the last page");
      // /sok resolves ?side= with resolveListPage, like /fylke and /sted (D3b):
      // a page past the last one is page 1, with its cards.
      const sokPage = (html: string): string | null => (html.match(/viser side (\d+ av \d+)/) || [])[1] ?? null;
      const sokFirst = await callRoute(router, "/sok?fylke=Oslo");
      const sokPast = await callRoute(router, "/sok?fylke=Oslo&side=999");
      const sokPastPages = navHrefs(sokPast.text).map((h) => Number((h.match(/[?&]side=(\d+)/) || [])[1] ?? 1));
      assertEq([sokPast.status, sokPage(sokPast.text), cardCount(sokPast.text)], [200, "1 av 3", pageSize], "D25: /sok?fylke=Oslo&side=999 (3 pages) is page 1 with 50 cards (regression: «side 999 av 3» and no cards)");
      assertTrue(!sokPast.text.includes("Ingen klinikker funnet") && sokPastPages.length > 0 && Math.max(...sokPastPages) === 3, `D25b: …no «Ingen klinikker funnet», and no page past 3 linked (got ${JSON.stringify(sokPastPages)})`);
      for (const side of ["0", "-3", "abc", "4", "999", "99999999999999999999", ""]) {
        const r = await callRoute(router, `/sok?fylke=Oslo&side=${encodeURIComponent(side)}`);
        assertEq([r.status, sokPage(r.text), cardHrefs(r.text)], [200, "1 av 3", cardHrefs(sokFirst.text)], `D26: /sok?fylke=Oslo&side=${side || "(empty)"} renders page 1`);
      }
      const sok2 = await callRoute(router, "/sok?fylke=Oslo&side=2");
      assertEq([sokPage(sok2.text), cardCount(sok2.text)], ["2 av 3", pageSize], "D27: control — side=2 is page 2 of 3, 50 cards");
      assertTrue(cardHrefs(sok2.text).every((h) => !cardHrefs(sokFirst.text).includes(h)), "D27b: …other clinics than page 1");
      const sok3 = await callRoute(router, "/sok?fylke=Oslo&side=3");
      assertEq([sokPage(sok3.text), cardCount(sok3.text)], ["3 av 3", 20], "D28: the last page, side=3, is page 3 of 3 with 20 cards");
      const sokNone = await callRoute(router, "/sok?q=finnes-ikke-noe-sted&side=2");
      assertEq([sokNone.status, sokPage(sokNone.text), cardCount(sokNone.text)], [200, "1 av 1", 0], "D29: no hits with side=2 is «side 1 av 1» (regression: «side 2 av 1»)");

      // On the route: the last page of /fylke/Oslo is linked from page 1.
      const f1 = await callRoute(router, "/fylke/Oslo");
      assertTrue(navHrefs(f1.text).includes("/fylke/Oslo?side=3"), "D20: /fylke/Oslo page 1 links its last page (side=3)");
      const s1 = await callRoute(router, "/spesialitet/kjeveortopedi");
      assertTrue(navHrefs(s1.text).includes("/spesialitet/kjeveortopedi?side=2"), "D21: /spesialitet page 1 links page 2 (regression: no page nav)");
    }

    // ── E. canonical per page; bad side = page 1 ─────────────────────────
    {
      for (const path of ["/fylke/Oslo", "/sted/oslo", "/spesialitet/kjeveortopedi"]) {
        const p1 = await callRoute(router, path);
        const p2 = await callRoute(router, `${path}?side=2`);
        assertEq(canonicalOf(p1.text), `${base}${path}`, `E1: ${path} page 1 canonical has no query`);
        assertEq(canonicalOf(p2.text), `${base}${path}?side=2`, `E2: ${path}?side=2 is its own canonical (regression: pointed at page 1)`);
        assertEq(ogUrlOf(p2.text), `${base}${path}?side=2`, `E3: ${path}?side=2 og:url follows the canonical`);
        assertEq(robotsOf(p2.text), ["index, follow, max-snippet:-1, max-image-preview:large"], `E4: ${path}?side=2 is indexable`);
        const firstCards = cardHrefs(p1.text);
        for (const bad of ["1", "0", "-3", "abc", "999", ""]) {
          const r = await callRoute(router, `${path}?side=${bad}`);
          assertEq(r.status, 200, `E5: ${path}?side=${bad} -> 200`);
          assertEq(canonicalOf(r.text), `${base}${path}`, `E6: ${path}?side=${bad} -> page 1 canonical`);
          assertEq(cardHrefs(r.text), firstCards, `E7: ${path}?side=${bad} renders page 1`);
        }
      }
      // Page N ≥ 2 has its own title and description; page 1 keeps its own.
      for (const path of ["/fylke/Oslo", "/sted/oslo", "/spesialitet/kjeveortopedi"]) {
        const [p1, p2] = [await callRoute(router, path), await callRoute(router, `${path}?side=2`)];
        const t1 = titleOf(p1.text) ?? "";
        const t2 = titleOf(p2.text) ?? "";
        assertTrue(!/side \d/.test(t1) && !/Side \d/.test(descriptionOf(p1.text) ?? ""), `E9: ${path} page 1 title and description name no page (${t1})`);
        assertEq(t2, t1.replace(/ (—|\|) /, " – side 2 $1 "), `E10: ${path}?side=2 title = page 1's with « – side 2» (regression: same title as page 1)`);
        assertTrue((descriptionOf(p2.text) ?? "").endsWith(" Side 2 av " + (path.startsWith("/spesialitet") ? 2 : 3) + "."), `E11: ${path}?side=2 description ends «Side 2 av N.» (${descriptionOf(p2.text)})`);
      }
      const titles = await Promise.all(["", "?side=2", "?side=3"].map(async (q) => titleOf((await callRoute(router, `/sted/oslo${q}`)).text)));
      assertEq(new Set(titles).size, 3, "E12: the three pages of /sted/oslo have three different titles");
      assertEq([dentalSeo.listPageMeta(1, 3), dentalSeo.listPageMeta(3, 3)], [{ title: "", description: "" }, { title: " – side 3", description: " Side 3 av 3." }], "E13: listPageMeta");

      // The breadcrumb still ends at the list itself, not the page.
      const crumbs = jsonLdBlocks((await callRoute(router, "/fylke/Oslo?side=2")).text).find((b) => b && b["@type"] === "BreadcrumbList");
      assertEq(crumbs?.itemListElement?.at(-1)?.item, `${base}/fylke/Oslo`, "E8: breadcrumb unchanged on page 2");
    }

    // ── F. /spesialitet paging ───────────────────────────────────────────
    {
      const p1 = await callRoute(router, "/spesialitet/kjeveortopedi");
      const p2 = await callRoute(router, "/spesialitet/kjeveortopedi?side=2");
      assertTrue(store.countPublicDentalAgents({ specialty: "kjeveortopedi" }) > pageSize, "F1: fixture sanity — total over one page");
      assertEq(p2.status, 200, "F2: /spesialitet/kjeveortopedi?side=2 -> 200");
      const a = cardHrefs(p1.text);
      const b = cardHrefs(p2.text);
      assertTrue(b.length > 0 && b.every((h) => !a.includes(h)), "F3: page 2 shows other clinics than page 1");
      assertEq(new Set([...a, ...b]).size, 60, "F4: the two pages together show all 60 (the closed one left out)");
      assertTrue(p2.text.includes("60 klinikker funnet &mdash; side 2 av 2"), "F5: page 2 says which page it is");
      assertTrue(!p1.text.includes("Nedlagt Oslo Klinikk"), "F6: closed clinic stays out");
    }

    // ── G. 404s: noindex (I-Q), no canonical, no og:url ──────────────────
    {
      // A rejected clinic and the synthetic probe row 404 by id and by slug.
      const rejectedId = mk("Avvist Oslo Klinikk AS", "OSLO", "Oslo");
      db.prepare("UPDATE dental_agents SET verification_status = 'rejected' WHERE id = ?").run(rejectedId);
      const rejected = store.getDentalAgentById(rejectedId)!;
      db.prepare(
        `INSERT INTO dental_agents (id, org_nr, navn, poststed, fylke, adresse, verification_status, catalog_class)
         VALUES ('persistence-probe-pr100b', '999999999', 'PR-100b Persistence Probe', 'TEST', 'Oslo', 'Volume Test 1', 'needs_review', 'klinikk')`
      ).run();
      const notFound: Array<[string, string]> = [
        ["/finnes-ikke", "catch-all"],
        ["/finnes-ikke-404", "catch-all"],
        ["/sted/finnes-ikke", "unknown sted"],
        ["/fylke/Atlantis", "unknown fylke"],
        ["/spesialitet/finnes-ikke", "unknown specialty"],
        ["/klinikk/finnes-ikke", "clinic slug without an org.nr"],
        ["/klinikk/finnes-ikke--123456789", "clinic slug, unknown org.nr"],
        ["/klinikk/id/finnes-ikke", "unknown clinic id"],
        [`/klinikk/id/${rejectedId}`, "rejected clinic by id"],
        [`/klinikk/${dentalSeo.slugifyClinic(rejected.navn, rejected.org_nr ?? undefined)}`, "rejected clinic by slug"],
        ["/klinikk/id/persistence-probe-pr100b", "probe row by id"],
        [`/klinikk/${dentalSeo.slugifyClinic("PR-100b Persistence Probe", "999999999")}`, "probe row by slug"],
      ];
      for (const [p, what] of notFound) {
        const r = await callRoute(router, p);
        assertEq([r.status, robotsOf(r.text)], [404, ["noindex, follow"]], `G1: ${p} (${what}) -> 404 with noindex, follow`);
        assertTrue(!r.text.includes('rel="canonical"'), `G2: ${p} (${what}) has no canonical link (regression: canonical = the homepage)`);
        assertTrue(!r.text.includes('property="og:url"'), `G3: ${p} (${what}) has no og:url (regression: og:url = the homepage)`);
        assertTrue(r.text.includes('<meta property="og:title"') && r.text.includes('<link rel="icon"'), `G4: ${p} (${what}) keeps the rest of the head`);
      }
      // Pages that are not 404s keep both, and the homepage default stays.
      for (const [p, want] of [["/", base], ["/om", `${base}/om`], ["/sted/oslo", `${base}/sted/oslo`]] as const) {
        const r = await callRoute(router, p);
        assertEq([r.status, canonicalOf(r.text), ogUrlOf(r.text)], [200, want, want], `G5: ${p} keeps canonical and og:url = ${want}`);
      }
    }

    // ── H. titles escaped once (D3b) ─────────────────────────────────────
    {
      const head = (html: string): string => html.slice(0, html.indexOf("</head>"));
      /** <title>, og:title and twitter:title, as written in the HTML. */
      const titles = (html: string): Array<string | null> => [
        titleOf(html),
        (html.match(/<meta property="og:title" content="([^"]*)">/) || [])[1] ?? null,
        (html.match(/<meta name="twitter:title" content="([^"]*)">/) || [])[1] ?? null,
      ];
      const cases: Array<[string, number, string, string]> = [
        ["/sok?q=A%26B", 200, "A&amp;B — Tannlege søk", "H1"],
        [`/sok?q=${encodeURIComponent('<b>"x"')}`, 200, "&lt;b&gt;&quot;x&quot; — Tannlege søk", "H2"],
        ["/fylke/A%26B", 404, "A&amp;B — Fylke ikke funnet | Finn-tannlege.com", "H3"],
        ["/sted/sankt-hans-haugen", 200, "Tannlege i Sankt Hans&#39; Haugen — Finn-tannlege.com", "H4"],
      ];
      for (const [url, status, want, id] of cases) {
        const r = await callRoute(router, url);
        assertEq([r.status, titles(r.text)], [status, [want, want, want]], `${id}: ${url} has «${want}» in <title>, og:title and twitter:title`);
        assertTrue(!/&amp;(amp|lt|gt|quot|#39);/.test(head(r.text)), `${id}b: ${url} has no doubly escaped entity in the head (regression: &amp;amp;)`);
      }
      assertTrue(!/<b>/.test(head((await callRoute(router, `/sok?q=${encodeURIComponent('<b>"x"')}`)).text)), "H2c: no raw <b> in the head");
      // Controls: titles with nothing to escape are byte-identical to before.
      const controls: Array<[string, string]> = [
        ["/fylke/Oslo", "Tannleger i Oslo — Finn-tannlege.com"],
        ["/sted/oslo", "Tannlege i Oslo — Finn-tannlege.com"],
        ["/fylke/Oslo?side=2", "Tannleger i Oslo – side 2 — Finn-tannlege.com"],
        ["/sok", "Søk etter tannlege — Finn-tannlege.com"],
        ["/sok?q=Bergen", "Bergen — Tannlege søk"],
        ["/fylke/Atlantis", "Atlantis — Fylke ikke funnet | Finn-tannlege.com"],
      ];
      for (const [url, want] of controls) {
        assertEq(titles((await callRoute(router, url)).text), [want, want, want], `H5: ${url} title unchanged`);
      }
    }
  } catch (err: any) {
    failed++;
    failures.push("dental indexing hygiene: unexpected error: " + String(err?.stack || err?.message || err));
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
  runDentalIndexingHygieneTests({ log: true }).then((r) => {
    console.log(`\ndental indexing hygiene (F1-S1): ${r.passed} passed, ${r.failed} failed`);
    if (r.failures.length) console.log(r.failures.join("\n"));
    process.exit(r.failed > 0 ? 1 : 0);
  });
}
