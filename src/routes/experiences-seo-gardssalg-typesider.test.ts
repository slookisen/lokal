/**
 * experiences-seo-gardssalg-typesider.test.ts — route + store tests for S3 of
 * dev-request 2026-08-06-opplevagent-ux-loft-drikkested-lansering:
 * indexable /kategori/gardssalg/<typeSlug> drink-type subpages, the
 * GARDSSALG_TYPE_PAGES whitelist + alias 301s, the type-chips row + searchBox
 * on the gårdssalg catalog, the per-type sitemap entries, and the additive
 * producer-type filter on listGardssalgProviders()/countGardssalgProviders()/
 * listGardssalgProviderMapPoints().
 *
 * Covers (per the S3 spec):
 *   (a) /kategori/gardssalg/bryggeri → 200 with ONLY bryggeri cards (filtered
 *       grid AND filtered map data island).
 *   (b) cideri- and sideri-rows both render on /kategori/gardssalg/sider.
 *   (c) an empty (0-provider) canonical type → handled=false (next() — the
 *       404 guard, no thin page).
 *   (d) an unknown slug → next().
 *   (e) alias `sideri` → 301 with Location /kategori/gardssalg/sider (and
 *       the other aliases → their canonical slugs; ?page= preserved).
 *   (f) canonical link + <title> + answer-first lede with the LIVE count,
 *       plus CollectionPage + BreadcrumbList JSON-LD on the type page.
 *   (g) chips row on the base page with correct aggregated counts,
 *       aria-current="page" + chip-active on the active chip (base «Alle» /
 *       type page's own chip).
 *   (h) catalog_hidden=1 rows never visible — not in any grid, not in any
 *       chip count, not in the sitemap.
 *   (i) sitemap.xml lists every canonical type page with ≥1 provider and
 *       NEVER an empty type or an alias URL.
 *   (j) regression: the base catalog still shows ALL types incl. the
 *       NULL-producer_type rfb-seed row.
 *   (k) searchBox (category-boosted to gardssalg) present on base + type page.
 *   (l) store unit: omitted/empty filter is result-identical to the pre-S3
 *       calls; a real filter returns only (case-insensitively) matching rows,
 *       never NULL-type rows, never catalog_hidden rows.
 *   (m) S2b (animated line-drawn still): the .oa-still-sketch backdrop
 *       renders on the base catalog AND the type pages (aria-hidden,
 *       pointer-events:none, absolute inset:0, wide+narrow crops, liquid
 *       path), its animation timeline lives EXCLUSIVELY inside
 *       @media (prefers-reduced-motion: no-preference) (reduced-motion UAs
 *       get the static finished drawing), and it NEVER renders on the
 *       homepage.
 *
 * Same synthetic-harness + in-memory-DB pattern as
 * experiences-seo-site-chrome.test.ts (S1) /
 * experiences-seo-forside-drikkested.test.ts (S2). Routes are invoked
 * directly on their router layer (the tests/test.ts invokeSeo pattern) so a
 * handler's next() is observable as handled=false instead of falling through
 * to the router's trailing 404 catch-all.
 *
 * Two ways to run:
 *   1. Standalone:  npx tsx src/routes/experiences-seo-gardssalg-typesider.test.ts
 *   2. Wired into the gate: tests/test.ts imports
 *      runExperiencesSeoGardssalgTypesiderTests() and folds its pass/fail
 *      counts into the `npm test` summary.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type InvokeResult = {
  found: boolean;   // the router has a layer for the route path at all
  handled: boolean; // the handler sent a response (false = it next()'d)
  status: number;
  body: string;
  headers: Record<string, string>;
};

// Direct route-layer invocation (the tests/test.ts invokeSeo pattern): finds
// the GET layer whose route.path matches, calls its final handler with a
// synthetic req/res, and reports next() as handled=false. All the handlers
// under test are synchronous (they end in res.send/res.redirect before
// returning), so the result is complete when the call returns.
function invokeRoute(
  router: any,
  routePath: string,
  params: Record<string, string>,
  reqPath: string,
  query: Record<string, string> = {}
): InvokeResult {
  const layer = (router.stack as any[]).find(
    (l: any) => l.route && l.route.path === routePath && l.route.methods?.get
  );
  if (!layer) return { found: false, handled: false, status: 0, body: "", headers: {} };
  let status = 200;
  let body = "";
  let handled = false;
  const headers: Record<string, string> = {};
  const res: any = {
    statusCode: 200,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); },
    status(code: number) { status = code; this.statusCode = code; return this; },
    send(b: unknown) { handled = true; body = typeof b === "string" ? b : String(b); return this; },
    redirect(code: number, loc: string) {
      handled = true;
      status = code;
      headers["location"] = loc;
      return this;
    },
  };
  const req: any = {
    method: "GET",
    path: reqPath,
    originalUrl: reqPath,
    url: reqPath,
    hostname: "opplevagent.no",
    params,
    query,
    headers: {},
    lang: "no",
    get() { return undefined; },
  };
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  handler(req, res, () => { /* next() */ });
  return { found: true, handled, status, body, headers };
}

// Media-block helpers (same brace-matching approach as the S2 forside test —
// a regex can't balance the nested @keyframes braces). extractAllMediaBlocks
// concatenates EVERY matching block: the gardssalg pages carry two
// no-preference guards (hero steam + the S2b sketch timeline).
function extractMediaBlock(css: string, mediaPrelude: string): { block: string; rest: string } | null {
  const start = css.indexOf(mediaPrelude);
  if (start < 0) return null;
  const braceStart = css.indexOf("{", start);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return { block: css.slice(braceStart + 1, i), rest: css.slice(i + 1) };
    }
  }
  return null;
}

function extractAllMediaBlocks(css: string, mediaPrelude: string): string[] {
  const blocks: string[] = [];
  let rest = css;
  for (;;) {
    const hit = extractMediaBlock(rest, mediaPrelude);
    if (!hit) break;
    blocks.push(hit.block);
    rest = hit.rest;
  }
  return blocks;
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx >= 0) {
    n++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return n;
}

const REDUCED_MOTION_PRELUDE = "@media (prefers-reduced-motion: no-preference)";

// One raw-SQL provider insert — same column set as the S1/S2 fixtures (there
// is no service-layer setter for producer_type / catalog_hidden /
// rfb_seed_source). slug = id so type-page cards/map markers resolve.
function insertProvider(
  db: any,
  p: {
    id: string;
    navn: string;
    producer_type: string | null;
    catalog_hidden?: number | null;
    rfb_seed_source?: string | null;
  }
): void {
  db.prepare(
    `INSERT INTO experience_providers
       (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden,
        rfb_seed_source, lat, lon, geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
     VALUES
       (?, ?, 'experiences', 'Innlandet', 'Ringsaker', 'Brumunddal', ?, NULL, ?,
        ?, 60.88, 10.94, 'high', ?, 'raw', 'pending_verify', 'test-fixture', 'medium')`
  ).run(p.id, p.navn, p.producer_type, p.catalog_hidden ?? null, p.rfb_seed_source ?? null, p.id);
}

export function runExperiencesSeoGardssalgTypesiderTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
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

  return (async () => {
    const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
    process.env.EXPERIENCES_DB_PATH = ":memory:";

    const dbFactoryPath = require.resolve("../database/db-factory");
    const expStorePath = require.resolve("../services/experience-store");
    const seoPath = require.resolve("./experiences-seo");
    const cachePaths = [dbFactoryPath, expStorePath, seoPath];
    for (const p of cachePaths) delete require.cache[p];

    try {
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const db = dbFactory.getDb("experiences");
      const store = require("../services/experience-store") as typeof import("../services/experience-store");

      // Fixture: 6 visible providers (≥5 → gardssalgVisible()) + 1 hidden.
      // bryggeri×2, sideri+cideri (both → /sider), mjøderi×1, NULL-type
      // rfb-seed×1 («Alle» only), and a catalog_hidden=1 bryggeri that must
      // never surface anywhere. kombucha/destilleri/fruktvin stay EMPTY.
      insertProvider(db, { id: "ts-brygg-1", navn: "Liaberg Bryggeri", producer_type: "bryggeri" });
      // ts-brygg-2 stores mixed case on purpose: the type filter must be
      // case-insensitive on the COLUMN side too, not just the input side.
      insertProvider(db, { id: "ts-brygg-2", navn: "Haugtun Bryggeri", producer_type: "Bryggeri" });
      insertProvider(db, { id: "ts-sideri-1", navn: "Eplelund Sideri", producer_type: "sideri" });
      insertProvider(db, { id: "ts-cideri-1", navn: "Hagen Cideri", producer_type: "cideri" });
      insertProvider(db, { id: "ts-mjod-1", navn: "Vollen Mjøderi", producer_type: "mjøderi" });
      insertProvider(db, { id: "ts-null-1", navn: "Seterhagen Gard", producer_type: null, rfb_seed_source: "rfb-seed" });
      insertProvider(db, { id: "ts-hidden-1", navn: "Skjult Bryggeri", producer_type: "bryggeri", catalog_hidden: 1 });

      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = (seo as any).default;

      const TYPE_ROUTE = "/kategori/gardssalg/:typeSlug";
      const base = invokeRoute(router, "/kategori/gardssalg", {}, "/kategori/gardssalg");
      const brygg = invokeRoute(router, TYPE_ROUTE, { typeSlug: "bryggeri" }, "/kategori/gardssalg/bryggeri");
      const sider = invokeRoute(router, TYPE_ROUTE, { typeSlug: "sider" }, "/kategori/gardssalg/sider");

      // ── (a) /kategori/gardssalg/bryggeri: ONLY bryggeri cards ─────────
      assertTrue(brygg.found && brygg.handled && brygg.status === 200, `a1: GET /kategori/gardssalg/bryggeri renders 200 (got found=${brygg.found} handled=${brygg.handled} status=${brygg.status})`);
      assertTrue(brygg.body.includes("Liaberg Bryggeri") && brygg.body.includes("Haugtun Bryggeri"), "a2: both visible bryggeri providers render on the type page");
      for (const absent of ["Eplelund Sideri", "Hagen Cideri", "Vollen Mjøderi", "Seterhagen Gard"]) {
        assertTrue(!brygg.body.includes(absent), `a3: non-bryggeri provider «${absent}» does NOT render on the bryggeri page`);
      }
      // Filtered map: the data island carries exactly the 2 bryggeri markers.
      const mapMatch = brygg.body.match(/<script type="application\/json" id="gardssalg-map-data">([\s\S]*?)<\/script>/);
      assertTrue(!!mapMatch, "a4: type page renders the gardssalg map data island");
      const markers: Array<{ slug: string }> = mapMatch ? JSON.parse(mapMatch[1]) : [];
      assertTrue(markers.length === 2, `a5: map data island holds exactly the 2 bryggeri markers (got ${markers.length})`);
      assertTrue(markers.every((m) => m.slug.startsWith("ts-brygg-")), "a6: every marker on the type page is a bryggeri row");

      // ── (b) cideri + sideri both land on /kategori/gardssalg/sider ────
      assertTrue(sider.found && sider.handled && sider.status === 200, `b1: GET /kategori/gardssalg/sider renders 200 (got handled=${sider.handled} status=${sider.status})`);
      assertTrue(sider.body.includes("Eplelund Sideri"), "b2: the sideri-spelled row renders on /sider");
      assertTrue(sider.body.includes("Hagen Cideri"), "b3: the cideri-spelled row ALSO renders on /sider (both raw spellings aggregate)");
      assertTrue(!sider.body.includes("Liaberg Bryggeri") && !sider.body.includes("Seterhagen Gard"), "b4: bryggeri/NULL-type rows do not leak onto /sider");

      // ── (c) empty canonical type → next() (404-guarded) ───────────────
      const empty = invokeRoute(router, TYPE_ROUTE, { typeSlug: "kombucha" }, "/kategori/gardssalg/kombucha");
      assertTrue(empty.found && !empty.handled, `c1: a canonical type with 0 providers (kombucha) next()s — handled=false (got handled=${empty.handled})`);

      // ── (d) unknown slug → next() ─────────────────────────────────────
      const unknown = invokeRoute(router, TYPE_ROUTE, { typeSlug: "tullball" }, "/kategori/gardssalg/tullball");
      assertTrue(unknown.found && !unknown.handled, `d1: an unknown slug next()s — handled=false (got handled=${unknown.handled})`);
      // Prototype keys must behave like any unknown slug: a plain-object
      // lookup without an own-property guard would resolve "constructor"/
      // "__proto__" and 301/render garbage instead of falling through.
      for (const protoKey of ["constructor", "__proto__"]) {
        const r = invokeRoute(router, TYPE_ROUTE, { typeSlug: protoKey }, `/kategori/gardssalg/${protoKey}`);
        assertTrue(r.found && !r.handled, `d2-${protoKey}: prototype key «${protoKey}» next()s — handled=false (got handled=${r.handled} status=${r.status})`);
      }

      // ── (e) alias slugs 301 to the canonical URL ──────────────────────
      const aliasCases: Array<[string, string]> = [
        ["sideri", "sider"], ["cideri", "sider"],
        ["vingard", "fruktvin"], ["vingaard", "fruktvin"],
        ["mjoderi", "mjod"], ["mjoederi", "mjod"],
        ["seltzeri", "kombucha"],
      ];
      for (const [alias, canonical] of aliasCases) {
        const r = invokeRoute(router, TYPE_ROUTE, { typeSlug: alias }, `/kategori/gardssalg/${alias}`);
        assertTrue(
          r.handled && r.status === 301 && r.headers["location"] === `/kategori/gardssalg/${canonical}`,
          `e1-${alias}: alias 301s to /kategori/gardssalg/${canonical} (got status=${r.status} location=${r.headers["location"]})`
        );
      }
      const aliasPaged = invokeRoute(router, TYPE_ROUTE, { typeSlug: "sideri" }, "/kategori/gardssalg/sideri", { page: "2" });
      assertTrue(
        aliasPaged.status === 301 && aliasPaged.headers["location"] === "/kategori/gardssalg/sider?page=2",
        `e2: the alias redirect preserves ?page= (got ${aliasPaged.headers["location"]})`
      );

      // ── (f) canonical + title + answer-first lede with LIVE count ─────
      assertTrue(
        brygg.body.includes('<link rel="canonical" href="https://opplevagent.no/kategori/gardssalg/bryggeri">'),
        "f1: type page canonical points at its own canonical type URL"
      );
      assertTrue(
        brygg.body.includes("<title>Bryggerier med gårdssalg og smaking | Opplevagent</title>"),
        "f2: type page has its own <title>"
      );
      assertTrue(
        brygg.body.includes("Det finnes 2 bryggerier på Opplevagent"),
        "f3: answer-first lede states the LIVE count (2 bryggerier — the hidden one excluded)"
      );
      assertTrue(
        brygg.body.includes('"@type":"CollectionPage"') && brygg.body.includes('"@type":"BreadcrumbList"'),
        "f4: type page carries CollectionPage + BreadcrumbList JSON-LD"
      );
      assertTrue(
        brygg.body.includes('"item":"https://opplevagent.no/kategori/gardssalg"'),
        "f5: BreadcrumbList links back to the base catalog"
      );
      // The base catalog keeps its pre-S3 head byte-identically.
      assertTrue(
        base.body.includes("<title>Gårdssalg og smaking | Opplevagent</title>") &&
        base.body.includes('<link rel="canonical" href="https://opplevagent.no/kategori/gardssalg">'),
        "f6: base catalog keeps its own title + canonical (regression)"
      );

      // ── (g) chips row: counts + active marking ────────────────────────
      const chipsBase = (base.body.match(/<nav class="chips gardssalg-type-chips"[^>]*>([\s\S]*?)<\/nav>/) || ["", ""])[1];
      assertTrue(chipsBase.length > 0, "g1: base catalog renders the type-chips row");
      assertTrue(
        chipsBase.includes('<a class="chip chip-active" aria-current="page" href="/kategori/gardssalg">Alle <span class="n">6</span></a>'),
        "g2: «Alle» chip is active on the base page with the full visible count (6 — incl. the NULL-type row, excl. the hidden row)"
      );
      assertTrue(
        chipsBase.includes('href="/kategori/gardssalg/bryggeri">Bryggeri <span class="n">2</span>'),
        "g3: Bryggeri chip links its type page with aggregated count 2"
      );
      assertTrue(
        chipsBase.includes('href="/kategori/gardssalg/sider">Sider <span class="n">2</span>'),
        "g4: Sider chip aggregates cideri+sideri to count 2"
      );
      assertTrue(
        chipsBase.includes('href="/kategori/gardssalg/mjod">Mjød <span class="n">1</span>'),
        "g5: Mjød chip shows count 1"
      );
      for (const absentHref of ["/kategori/gardssalg/kombucha", "/kategori/gardssalg/destilleri", "/kategori/gardssalg/fruktvin"]) {
        assertTrue(!chipsBase.includes(`href="${absentHref}"`), `g6: no chip for the empty type ${absentHref}`);
      }
      const chipsBrygg = (brygg.body.match(/<nav class="chips gardssalg-type-chips"[^>]*>([\s\S]*?)<\/nav>/) || ["", ""])[1];
      assertTrue(
        chipsBrygg.includes('<a class="chip chip-active" aria-current="page" href="/kategori/gardssalg/bryggeri">'),
        "g7: on the type page the type's OWN chip carries chip-active + aria-current"
      );
      assertTrue(
        !chipsBrygg.includes('aria-current="page" href="/kategori/gardssalg">'),
        "g8: «Alle» is NOT marked current on a type page"
      );

      // ── (h) catalog_hidden never visible anywhere ─────────────────────
      assertTrue(!base.body.includes("Skjult Bryggeri"), "h1: hidden provider absent from the base grid");
      assertTrue(!brygg.body.includes("Skjult Bryggeri"), "h2: hidden provider absent from its own type's page");
      assertTrue(
        !chipsBase.includes('">Bryggeri <span class="n">3</span>'),
        "h3: hidden provider never inflates the Bryggeri chip count (2, not 3)"
      );

      // ── (i) sitemap: canonical type pages with hits, never empty/alias ─
      const sm = invokeRoute(router, "/sitemap.xml", {}, "/sitemap.xml");
      assertTrue(sm.found && sm.handled && sm.status === 200, `i1: sitemap.xml renders 200 (got ${sm.status})`);
      for (const present of ["bryggeri", "sider", "mjod"]) {
        assertTrue(
          sm.body.includes(`https://opplevagent.no/kategori/gardssalg/${present}</loc>`),
          `i2: sitemap lists the populated type page /kategori/gardssalg/${present}`
        );
      }
      for (const absent of ["kombucha", "destilleri", "fruktvin", "sideri", "cideri", "vingard", "vingaard", "mjoderi", "mjoederi", "seltzeri"]) {
        assertTrue(
          !sm.body.includes(`https://opplevagent.no/kategori/gardssalg/${absent}</loc>`),
          `i3: sitemap never lists the empty-type/alias URL /kategori/gardssalg/${absent}`
        );
      }
      assertTrue(
        sm.body.includes("https://opplevagent.no/kategori/gardssalg</loc>"),
        "i4: the base /kategori/gardssalg entry is still present (regression)"
      );
      assertTrue(!sm.body.includes("ts-hidden-1"), "i5: the hidden provider's profile URL stays out of the sitemap");

      // ── (j) regression: base page shows ALL types incl. NULL-type ─────
      for (const navn of ["Liaberg Bryggeri", "Haugtun Bryggeri", "Eplelund Sideri", "Hagen Cideri", "Vollen Mjøderi", "Seterhagen Gard"]) {
        assertTrue(base.body.includes(navn), `j1: base catalog still shows «${navn}»`);
      }
      assertTrue(base.body.includes("6 produsenter"), "j2: base catalog count line still counts all 6 visible providers");

      // ── (k) searchBox on base + type page ─────────────────────────────
      for (const [name, page] of [["base", base], ["type", brygg]] as const) {
        assertTrue(
          page.body.includes('id="sok-q"') && page.body.includes('<input type="hidden" name="category" value="gardssalg">'),
          `k1-${name}: page renders the /sok searchBox with the gardssalg category boost`
        );
        // Placement: hero → searchbar → chips.
        const iHero = page.body.indexOf('class="hero-section"');
        const iSearch = page.body.indexOf('class="searchbar"');
        const iChips = page.body.indexOf('class="chips gardssalg-type-chips"');
        assertTrue(
          iHero >= 0 && iSearch > iHero && iChips > iSearch,
          `k2-${name}: order is hero(${iHero}) < searchBox(${iSearch}) < chips(${iChips})`
        );
      }

      // ── (l) store unit: additive filter parameter ─────────────────────
      const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort().join(",");
      const unfiltered = store.listGardssalgProviders(100, 0);
      assertTrue(
        idsOf(unfiltered) === idsOf(store.listGardssalgProviders(100, 0, undefined)) &&
        idsOf(unfiltered) === idsOf(store.listGardssalgProviders(100, 0, {})) &&
        idsOf(unfiltered) === idsOf(store.listGardssalgProviders(100, 0, { producerTypes: [] })),
        "l1: omitted/undefined/{}/empty-array filter all return the identical pre-S3 row set"
      );
      assertTrue(unfiltered.length === 6, `l2: unfiltered list is the 6 visible providers (got ${unfiltered.length})`);
      assertTrue(
        store.countGardssalgProviders() === 6 && store.countGardssalgProviders({}) === 6,
        "l3: countGardssalgProviders() with and without an empty filter both count 6"
      );
      const bryggRows = store.listGardssalgProviders(100, 0, { producerTypes: ["bryggeri"] });
      assertTrue(
        idsOf(bryggRows) === "ts-brygg-1,ts-brygg-2",
        `l4: bryggeri filter returns exactly the 2 visible bryggeri rows (hidden excluded) (got ${idsOf(bryggRows)})`
      );
      assertTrue(store.countGardssalgProviders({ producerTypes: ["bryggeri"] }) === 2, "l5: filtered count matches the filtered list");
      const mixedCase = store.listGardssalgProviders(100, 0, { producerTypes: ["BRYGGERI"] });
      assertTrue(idsOf(mixedCase) === "ts-brygg-1,ts-brygg-2", "l6: filter matching is case-insensitive on both sides");
      const siderRows = store.listGardssalgProviders(100, 0, { producerTypes: ["cideri", "sideri"] });
      assertTrue(idsOf(siderRows) === "ts-cideri-1,ts-sideri-1", `l7: multi-spelling filter unions cideri+sideri (got ${idsOf(siderRows)})`);
      const allTyped = store.listGardssalgProviders(100, 0, { producerTypes: ["bryggeri", "sideri", "cideri", "mjøderi"] });
      assertTrue(
        allTyped.length === 5 && !allTyped.some((r) => r.id === "ts-null-1"),
        `l8: a NULL producer_type row NEVER matches any type filter — base catalog («Alle») only (got ${allTyped.length})`
      );
      const mapFiltered = store.listGardssalgProviderMapPoints({ producerTypes: ["cideri", "sideri"] });
      assertTrue(
        mapFiltered.length === 2 && mapFiltered.every((m) => m.slug === "ts-cideri-1" || m.slug === "ts-sideri-1"),
        `l9: map-point selector honors the same filter (got ${mapFiltered.map((m) => m.slug).join(",")})`
      );
      assertTrue(
        store.listGardssalgProviderMapPoints().length === 6,
        "l10: unfiltered map points unchanged (all 6 visible geocoded rows)"
      );

      // ── (m) S2b: animated line-drawn still on the gardssalg surfaces ──
      for (const [name, page] of [["base", base], ["type", brygg]] as const) {
        // Backdrop layer present, decorative and click-through: the wrapper
        // div AND both svg crops are aria-hidden; the CSS pins the layer
        // absolute inset:0 under the content with pointer-events:none.
        assertTrue(
          page.body.includes('<div class="oa-still-sketch" aria-hidden="true">'),
          `m1-${name}: page renders the aria-hidden .oa-still-sketch layer`
        );
        assertTrue(
          /<svg class="sketch-wide"[^>]*aria-hidden="true"[^>]*focusable="false">/.test(page.body) &&
          /<svg class="sketch-narrow"[^>]*aria-hidden="true"[^>]*focusable="false">/.test(page.body),
          `m2-${name}: both the wide and the narrow (mobile) crop render with aria-hidden + focusable=false`
        );
        assertTrue(
          page.body.includes(".oa-still-sketch{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0}"),
          `m3-${name}: sketch layer CSS is absolute inset:0 + pointer-events:none + z-index:0`
        );
        // The stage wrapper sits AROUND <main> so the drawing spans the
        // whole light surface (margins included), with main lifted above it.
        const iStage = page.body.indexOf('class="oa-sketch-stage"');
        const iSketch = page.body.indexOf('class="oa-still-sketch"');
        const iMain = page.body.indexOf('id="main"');
        assertTrue(
          iStage >= 0 && iSketch > iStage && iMain > iSketch &&
          page.body.includes(".oa-sketch-stage>main{position:relative;z-index:1}"),
          `m4-${name}: stage(${iStage}) wraps sketch(${iSketch}) + main(${iMain}), main z-lifted above the drawing`
        );
        // Liquid pass: the copper sk-vaeske group draws AFTER the black
        // apparatus in the timeline (58–76% vs the last line window at 56%).
        assertTrue(
          page.body.includes('class="sk-vaeske"') && page.body.includes(".oa-still-sketch .sk-vaeske path{stroke:#c98a2b"),
          `m5-${name}: the liquid (sk-vaeske) pass is present in copper`
        );
        // Reduced-motion: every @keyframes on the page (steam + all sketch
        // windows) lives inside a no-preference guard; the sketch's
        // dasharray/animation bindings do too, so reduce-UAs render the
        // static finished drawing (solid strokes, nothing dashed away).
        const guarded = extractAllMediaBlocks(page.body, REDUCED_MOTION_PRELUDE).join("\n");
        assertTrue(
          guarded.length > 0 && countOccurrences(page.body, "@keyframes") === countOccurrences(guarded, "@keyframes"),
          `m6-${name}: EVERY @keyframes sits inside a prefers-reduced-motion:no-preference block`
        );
        for (const kf of ["oaSkKjele", "oaSkHals", "oaSkKond", "oaSkRor", "oaSkFlaske", "oaSkVaeske", "oaSkFade"]) {
          assertTrue(guarded.includes(`@keyframes ${kf}`), `m7-${name}-${kf}: sketch timeline keyframe ${kf} is inside the guard`);
        }
        assertTrue(
          countOccurrences(page.body, "stroke-dasharray:1}") === countOccurrences(guarded, "stroke-dasharray:1}"),
          `m8-${name}: the sketch's stroke-dasharray only exists inside the guard (static render stays fully drawn)`
        );
      }
      // The identity belongs to the gardssalg surfaces ONLY — never the
      // homepage (Daniel's S2b directive).
      const homeM = invokeRoute(router, "/", {}, "/");
      assertTrue(homeM.found && homeM.handled && homeM.status === 200, `m9: GET / renders 200 (got ${homeM.status})`);
      assertTrue(!homeM.body.includes("oa-still-sketch"), "m10: the still sketch NEVER renders on the homepage");
      const sketchSvg = (seo as any).gardssalgStillSketchSvg();
      assertTrue(
        typeof sketchSvg === "string" && sketchSvg.length > 0 && sketchSvg.length < 50_000,
        `m11: the still-sketch SVG stays hand-written-small — under 50 000 chars (got ${sketchSvg?.length})`
      );
    } catch (err: any) {
      failed++;
      failures.push("experiences-seo-gardssalg-typesider: unexpected error: " + String(err?.stack || err?.message || err));
    } finally {
      if (prevExperiencesDbPath === undefined) {
        delete process.env.EXPERIENCES_DB_PATH;
      } else {
        process.env.EXPERIENCES_DB_PATH = prevExperiencesDbPath;
      }
      try {
        const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
        dbFactory.__resetDbFactoryForTesting();
      } catch {
        // best-effort cleanup
      }
      for (const p of cachePaths) delete require.cache[p];
    }

    return { passed, failed, failures };
  })();
}

if (require.main === module) {
  runExperiencesSeoGardssalgTypesiderTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    // Explicit exit on success too: requiring the seo route module leaves
    // live handles (email-service/counter timers) on the event loop, so a
    // fully green standalone run would otherwise hang instead of exiting.
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
