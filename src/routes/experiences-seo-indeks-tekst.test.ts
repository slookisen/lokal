/**
 * experiences-seo-indeks-tekst.test.ts — dev-request
 * 2026-10-17-integrasjonstest-oppfolging, slice I-B: the verified findings
 * from the 2026-10-17 integration test on Opplevagent's indexing and copy.
 *
 * Covers:
 *   (a) IDX-1, the predicate: the combo gate's threshold counts indexable
 *       experiences (indexableTotal), the facts stay over every published
 *       row; a cell of placeholders only is never indexable, at any
 *       threshold.
 *   (b) IDX-1, the store: getProduktByStats() and listProduktByCombos()
 *       return the same indexableTotal, which is the number of rows
 *       shouldNoindexExperience() lets through; countIndexablePublished-
 *       Experiences() never counts the whole catalog for a blank filter.
 *   (c) IDX-1, end to end: the repro cell (3 placeholder experiences from 2
 *       providers, like /kategori/mat_drikke/Bergen) and a cell with 3
 *       experiences of which 1 is indexable both answer 301 to /kommune and
 *       are neither in the sitemap nor in the /kommune chips; a cell with 2
 *       indexable + 1 placeholder is served and lists all 3; every combo in
 *       the sitemap has ≥2 indexable experiences (AC-B); a description
 *       landing lifts a cell over the gate (after the cache TTL for sitemap
 *       and chips); OPPLEVAGENT_PLACEHOLDER_NOINDEX="false" gives back the
 *       pre-IDX-1 behaviour.
 *   (d) IDX-2: a /kommune and a /tilbyder page whose experiences are all
 *       placeholders answer 200 with `noindex, follow` in the meta and the
 *       X-Robots-Tag header and are not in the sitemap; they stay linked; a
 *       page with ≥1 indexable experience is unchanged; a description landing
 *       makes the page index again; the kill switch turns the rule off.
 *   (e) IDX-4: /proveniens has a self-referencing canonical and a meta
 *       description without compliance claims.
 *   (f) SD-09: the browse pages' ItemList names are the card titles
 *       (title_no on /no, falling back to title; title on /en).
 *   (g) SD-11: /kategori/gardssalg and its type pages carry og:/twitter:
 *       tags with the gårdssalg PNG card; while booking is not live their
 *       meta description and hero invite an interest request and never say
 *       «book»; with booking live they keep the booking copy.
 *   (h) SD-12: the approximate-placement card on /opplevelse says
 *       «tilbyderen», never «produsenten».
 *   (i) SD-13: placePreposition()/inPlace(): «på» for island and
 *       archipelago names, «i» otherwise; /fylke/Svalbard and a combo page
 *       on Hitra say «på» in title, h1, meta, lede, FAQ and aria-label,
 *       while /kommune/Bergen keeps «i».
 *   (j) «fra 0 kr» (FUNN sted-lede-fra-0-kr): with a cheapest price of 0
 *       the place, category and combo openings say «noen er gratis» and the
 *       FAQ answers «Noen opplevelser … er gratis»; other prices keep
 *       «fra N kr»; on a live page the visible FAQ still equals the JSON-LD.
 *
 * Run standalone: npx tsx src/routes/experiences-seo-indeks-tekst.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

type RouteResult = {
  handled: boolean;
  status: number;
  body: string;
  headers: Record<string, string>;
  location: string | null;
};

const NOINDEX_META = '<meta name="robots" content="noindex, follow">';
const INDEX_META = '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">';
// The Homme Gård case from description-quality.ts's module doc: skip-link +
// nav menu + contact block scraped as a "description".
const JUNK_DESCRIPTION =
  "Skip to content Homme 8, 4715 Øvrebø 41360545 john@hommegaard.no Facebook-f Instagram Forside Gårdsutsalg Produksjon Meny";

// Same synthetic router.handle() shortcut as experiences-seo-produktby-gate.test.ts,
// with the request language as a parameter.
function callHtmlRoute(router: any, url: string, lang: "no" | "en" = "no"): Promise<RouteResult> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const headers: Record<string, string> = {};
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers: {},
      lang,
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); },
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, body: "", headers, location: loc }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body), headers, location: null }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "", headers, location: null });
    });
  });
}

/** Every <loc> path in a sitemap body, decoded. */
function sitemapPaths(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>https?:\/\/[^/<]+([^<]*)<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeURIComponent(m[1]));
  return out;
}

/** "<category>/<kommune>" for every combo page an HTML page links to. */
function linkedCombos(html: string): string[] {
  const out: string[] = [];
  const re = /href="\/kategori\/([^"/]+)\/([^"/]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const cat = decodeURIComponent(m[1]);
    if (cat === "gardssalg") continue;
    out.push(`${cat}/${decodeURIComponent(m[2])}`);
  }
  return out;
}

function comboUrl(category: string, kommune: string): string {
  return `/kategori/${encodeURIComponent(category)}/${encodeURIComponent(kommune)}`;
}

function cardCount(html: string): number {
  return (html.match(/class="card card-cat"/g) || []).length;
}

/** The parsed JSON-LD blocks of a page. */
function ldBlocks(html: string): any[] {
  const out: any[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch { /* counted as missing */ }
  }
  return out;
}

/** The card titles of a browse grid, unescaped, in page order. */
function cardTitles(html: string): string[] {
  const out: string[] = [];
  const re = /<span class="c-title">([^<]*)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(unescapeHtml(m[1]));
  return out;
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function metaContent(html: string, attr: "name" | "property", key: string): string | null {
  const m = html.match(new RegExp(`<meta ${attr}="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" content="([^"]*)">`));
  return m ? unescapeHtml(m[1]) : null;
}

/** The visible FAQ of a page as [question, answer] pairs. */
function visibleFaq(html: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /<div class="faq-item"><h3>([^<]*)<\/h3><p>([^<]*)<\/p><\/div>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push([unescapeHtml(m[1]), unescapeHtml(m[2])]);
  return out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** «0 kr» as a price of its own (not the end of «1490 kr»). */
const ZERO_KR = /(^|[^\d])0 kr/;
const sameSet = (a: string[], b: string[]): boolean => same([...a].sort(), [...b].sort());

export function runExperiencesSeoIndeksTekstTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  const THRESHOLD_ENV = "OPPLEVAGENT_COMBO_MIN_EXPERIENCES";
  const NOINDEX_ENV = "OPPLEVAGENT_PLACEHOLDER_NOINDEX";
  const DISPATCH_ENV = "BOOKING_DISPATCH_ENABLED";
  const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  return (async () => {
    const prev = {
      db: process.env.EXPERIENCES_DB_PATH,
      threshold: process.env[THRESHOLD_ENV],
      noindex: process.env[NOINDEX_ENV],
      dispatch: process.env[DISPATCH_ENV],
    };
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    setEnv(THRESHOLD_ENV, undefined);
    setEnv(NOINDEX_ENV, undefined);
    setEnv(DISPATCH_ENV, undefined);

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("../services/booking-store"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      const ix = require("../services/experience-indexability") as typeof import("../services/experience-indexability");
      const prep = require("../services/place-preposition") as typeof import("../services/place-preposition");

      // ── (a) IDX-1: the predicate ───────────────────────────────────────────
      {
        const allPlaceholders = { total: 3, indexableTotal: 0, providerCount: 2, minPriceFrom: 250 };
        const oneIndexable = { total: 3, indexableTotal: 1, providerCount: 2, minPriceFrom: 250 };
        const twoIndexable = { total: 3, indexableTotal: 2, providerCount: 2, minPriceFrom: 250 };
        assertTrue(!ix.isProduktByCellIndexable(allPlaceholders),
          "ib-a1 (IDX-1): 3 published experiences that are all placeholders → not indexable (the Bergen mat_drikke repro)");
        assertTrue(!ix.isProduktByCellIndexable(oneIndexable),
          "ib-a2: 3 published, 1 indexable → not indexable at the default threshold 2");
        assertTrue(ix.isProduktByCellIndexable(twoIndexable),
          "ib-a3: 3 published, 2 indexable → indexable (the placeholder does not count against it)");
        setEnv(THRESHOLD_ENV, "1");
        assertTrue(!ix.isProduktByCellIndexable(allPlaceholders) && ix.isProduktByCellIndexable(oneIndexable),
          "ib-a4: threshold 1 still needs 1 indexable experience — a placeholders-only cell is never indexable");
        setEnv(THRESHOLD_ENV, "3");
        assertTrue(!ix.isProduktByCellIndexable(twoIndexable) && ix.isProduktByCellIndexable({ ...twoIndexable, indexableTotal: 3 }),
          "ib-a5: threshold 3 applies to indexableTotal, not total");
        setEnv(THRESHOLD_ENV, undefined);
        assertTrue(!ix.isProduktByCellIndexable({ total: 2, indexableTotal: 2, providerCount: 0, minPriceFrom: null }),
          "ib-a6: the ≥2-real-facts rule still applies (2 indexable, no provider, no price → not indexable)");
        assertTrue(ix.countProduktByRealFacts({ total: 3, providerCount: 2, minPriceFrom: 250 }) === 3,
          "ib-a7: the facts are counted over every published row (total/providers/price, not the indexable count)");
      }

      // ── (i, pure) SD-13: the preposition helper ────────────────────────────
      {
        const paa = ["Svalbard", "Hitra", "Frøya", "Karmøy", "Senja", "Smøla", "Jan Mayen", "Vestvågøy"];
        const i = ["Bergen", "Oslo", "Tromsø", "Vågan", "Lofoten", "Vesterålen", "Herøy", "Vestland", "Ålesund", ""];
        assertTrue(paa.every((n) => prep.placePreposition(n) === "på"),
          `ib-i1 (SD-13): «på» for island and archipelago names (${paa.filter((n) => prep.placePreposition(n) !== "på").join(", ") || "all ok"})`);
        assertTrue(i.every((n) => prep.placePreposition(n) === "i"),
          `ib-i2: «i» for every other place, incl. Lofoten/Vesterålen/Herøy and Tromsø (${i.filter((n) => prep.placePreposition(n) !== "i").join(", ") || "all ok"})`);
        assertTrue(prep.placePreposition(" svalbard ") === "på" && prep.placePreposition("HITRA") === "på",
          "ib-i3: matched on the trimmed name, ignoring case");
        assertTrue(prep.inPlace("Svalbard") === "på Svalbard" && prep.inPlace("Bergen") === "i Bergen",
          "ib-i4: inPlace() keeps the name as given, with its preposition");
      }

      // ── (j, pure) «fra 0 kr» in the builders ───────────────────────────────
      {
        const seoPure = require("./experiences-seo") as typeof import("./experiences-seo");
        const place = { kind: "fylke" as const, name: "Rogaland", total: 9, categoryCount: 3, kommuneCount: 4, providerCount: 5, minPriceFrom: 0 };
        const placeFaq = seoPure.buildPlaceFaqJsonLd({ ...place, url: "u" });
        const placeLede = seoPure.buildPlaceAnswerFirstOpening(place);
        assertTrue(!!placeFaq && placeFaq.mainEntity[3].acceptedAnswer.text === "Noen opplevelser i Rogaland er gratis — alle tilbydere er verifisert mot Brønnøysundregistrene.",
          `ib-j1 (0 kr): place FAQ price answer says «Noen opplevelser i Rogaland er gratis» (got ${JSON.stringify(placeFaq?.mainEntity?.[3]?.acceptedAnswer?.text)})`);
        assertTrue(placeLede === "Opplevelser i Rogaland: 9 opplevelser i 4 kommuner fordelt på 3 kategorier hos 5 tilbydere, noen er gratis — håndplukket og verifisert mot Brønnøysundregistrene.",
          `ib-j2: place opening says «noen er gratis» (got ${JSON.stringify(placeLede)})`);
        const cat = { label: "Natur & friluft", total: 12, fylkeCount: 3, kommuneCount: 5, minPriceFrom: 0 };
        const catFaq = seoPure.buildCategoryFaqJsonLd({ ...cat, url: "u" });
        const catLede = seoPure.buildCategoryAnswerFirstOpening(cat);
        assertTrue(!!catFaq && catFaq.mainEntity[2].acceptedAnswer.text === "Noen opplevelser i kategorien Natur & friluft er gratis — alle tilbydere er verifisert mot Brønnøysundregistrene.",
          `ib-j3: category FAQ price answer (got ${JSON.stringify(catFaq?.mainEntity?.[2]?.acceptedAnswer?.text)})`);
        assertTrue(catLede === "Natur & friluft på Opplevagent: 12 opplevelser i 3 fylker (5 kommuner), noen er gratis — håndplukket og verifisert mot Brønnøysundregistrene.",
          `ib-j4: category opening (got ${JSON.stringify(catLede)})`);
        const combo = { categoryLabel: "Mat & drikke", kommune: "Oslo", fylke: "Oslo", total: 4, providerCount: 3, minPriceFrom: 0 };
        const comboFaq = seoPure.buildProduktByFaqJsonLd({ ...combo, url: "u" });
        const comboLede = seoPure.buildProduktByAnswerFirstOpening(combo);
        assertTrue(!!comboFaq && comboFaq.mainEntity[2].acceptedAnswer.text === "Noen opplevelser innen mat & drikke i Oslo er gratis.",
          `ib-j5: combo FAQ price answer (got ${JSON.stringify(comboFaq?.mainEntity?.[2]?.acceptedAnswer?.text)})`);
        assertTrue(comboLede === "Mat & drikke i Oslo (Oslo): 4 opplevelser fra 3 tilbydere, noen er gratis — håndplukket og verifisert mot Brønnøysundregistrene.",
          `ib-j6: combo opening (got ${JSON.stringify(comboLede)})`);
        const all = JSON.stringify([placeFaq, placeLede, catFaq, catLede, comboFaq, comboLede]);
        assertTrue(!ZERO_KR.test(all), "ib-j7: no builder says «0 kr» for a free cheapest price");
        // A positive price keeps its wording.
        const priced = seoPure.buildPlaceAnswerFirstOpening({ ...place, minPriceFrom: 250 });
        const pricedFaq = seoPure.buildProduktByFaqJsonLd({ ...combo, minPriceFrom: 250, url: "u" });
        assertTrue(!!priced && priced.includes(", fra 250 kr — ") && !priced.includes("gratis")
          && !!pricedFaq && pricedFaq.mainEntity[2].acceptedAnswer.text === "Prisene for mat & drikke i Oslo starter fra 250 kr.",
          "ib-j8: a price above 0 is still «fra 250 kr» (regression)");
        // 0 is still a real fact for the gates: the price question exists.
        assertTrue(!!placeFaq && placeFaq.mainEntity.length === 4 && !!comboFaq && comboFaq.mainEntity.length === 3,
          "ib-j9: 0 kr still counts as a stated price (one FAQ question per fact, unchanged)");
      }

      // ── fixtures ───────────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences") as any;
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = seo.default as any;

      const mkProvider = (navn: string, fylke: string, kommune: string): string =>
        expStore.createProvider({ navn, fylke, kommune, brreg_verified: 1, brreg_active: 1, verification_status: "verified" });
      const mkExp = (o: {
        title: string; category: string; fylke: string; kommune: string; providerId: string;
        description: string | null; price?: number; titleNo?: string; kommuneGeo?: [number, number];
      }): { id: string; slug: string } => {
        const id = expStore.createExperience({
          title: o.title,
          provider_id: o.providerId,
          provider_match_status: "matched",
          category: o.category, fylke: o.fylke, kommune: o.kommune,
          ...(o.description !== null ? { description: o.description } : {}),
          ...(o.price !== undefined ? { price_from: o.price } : {}),
          ...(o.kommuneGeo ? { loc_lat: o.kommuneGeo[0], loc_lon: o.kommuneGeo[1], geo_precision: "kommune" as const } : {}),
          confidence: "high", verification_status: "verified",
        });
        if (o.titleNo) db.prepare("UPDATE experiences SET title_no = ? WHERE id = ?").run(o.titleNo, id);
        return { id, slug: (expStore.getExperienceById(id) as any).slug as string };
      };
      const real = (t: string): string => `${t} — guidet opplevelse med lokal tilbyder, utstyr og kaffe inkludert.`;

      // Bergen (Vestland).
      const provMatA = mkProvider("Bryggen Matturer AS", "Vestland", "Bergen"); // placeholders only
      const provMatB = mkProvider("Bergen Smak AS", "Vestland", "Bergen");      // one placeholder, one real
      const provNatur = mkProvider("Fløyen Friluft AS", "Vestland", "Bergen");
      // mat_drikke/Bergen — the repro: 3 placeholders from 2 providers.
      const matA1 = mkExp({ title: "Bergen nabolagsmat", category: "mat_drikke", fylke: "Vestland", kommune: "Bergen", providerId: provMatA, description: null });
      mkExp({ title: "Food tours Bergen", category: "mat_drikke", fylke: "Vestland", kommune: "Bergen", providerId: provMatA, description: "   " });
      mkExp({ title: "Mat- og kulturvandring", category: "mat_drikke", fylke: "Vestland", kommune: "Bergen", providerId: provMatB, description: JUNK_DESCRIPTION });
      // natur_friluft/Bergen — 2 real + 1 placeholder.
      const natur1 = mkExp({ title: "Ulriken Hike", titleNo: "Ulriken på tvers", category: "natur_friluft", fylke: "Vestland", kommune: "Bergen", providerId: provNatur, description: real("Ulriken på tvers"), price: 450 });
      const natur2 = mkExp({ title: "Fløyen Sunset", category: "natur_friluft", fylke: "Vestland", kommune: "Bergen", providerId: provMatB, description: real("Fløyen ved solnedgang") });
      mkExp({ title: "Byfjellene rundt", category: "natur_friluft", fylke: "Vestland", kommune: "Bergen", providerId: provNatur, description: null });
      // kultur_historie/Bergen — 3 published, 1 indexable (the Vågan/Rauma shape).
      mkExp({ title: "Byvandring på Bryggen", category: "kultur_historie", fylke: "Vestland", kommune: "Bergen", providerId: provNatur, description: real("Byvandring på Bryggen") });
      mkExp({ title: "Hanseatisk museum", category: "kultur_historie", fylke: "Vestland", kommune: "Bergen", providerId: provNatur, description: null });
      mkExp({ title: "Gamle Bergen", category: "kultur_historie", fylke: "Vestland", kommune: "Bergen", providerId: provMatB, description: null });
      // Flakstad (Nordland) — a kommune and a provider with placeholders only (IDX-2).
      const provFlak = mkProvider("Flakstad Kystopplevelser AS", "Nordland", "Flakstad");
      const flak1 = mkExp({ title: "Strandtur på Ramberg", category: "natur_friluft", fylke: "Nordland", kommune: "Flakstad", providerId: provFlak, description: null });
      mkExp({ title: "Kajakk i Flakstadpollen", category: "natur_friluft", fylke: "Nordland", kommune: "Flakstad", providerId: provFlak, description: "" });
      // Vågan (Nordland) — a real kommune in the same fylke, so /fylke/Nordland has chips.
      const provVagan = mkProvider("Lofoten Fiske AS", "Nordland", "Vågan");
      mkExp({ title: "Fisketur fra Svolvær", category: "natur_friluft", fylke: "Nordland", kommune: "Vågan", providerId: provVagan, description: real("Fisketur fra Svolvær") });
      // Svalbard — «på», and a free experience (0 kr).
      const provSval = mkProvider("Arktiske Turer AS", "Svalbard", "Longyearbyen");
      const sval1 = mkExp({ title: "Hundekjøring i Adventdalen", category: "dyreliv_safari", fylke: "Svalbard", kommune: "Longyearbyen", providerId: provSval, description: real("Hundekjøring i Adventdalen"), price: 1490, kommuneGeo: [78.22, 15.65] });
      mkExp({ title: "Byvandring i Longyearbyen", category: "dyreliv_safari", fylke: "Svalbard", kommune: "Longyearbyen", providerId: provSval, description: real("Byvandring i Longyearbyen"), price: 0 });
      // Hitra (Trøndelag) — a «på» kommune with a served combo page, and a
      // kommune-precision row for the approximate-placement card (SD-12).
      const provHitra = mkProvider("Hitra Havopplevelser AS", "Trøndelag", "Hitra");
      const hitra1 = mkExp({ title: "Havfiske utenfor Hitra", category: "natur_friluft", fylke: "Trøndelag", kommune: "Hitra", providerId: provHitra, description: real("Havfiske utenfor Hitra"), price: 650, kommuneGeo: [63.53, 8.82] });
      mkExp({ title: "Hjortesafari på Hitra", category: "natur_friluft", fylke: "Trøndelag", kommune: "Hitra", providerId: provHitra, description: real("Hjortesafari på Hitra"), price: 350 });

      const buildSitemap = async (): Promise<string[]> => {
        seo.__resetExperiencesSitemapCacheForTesting();
        const r = await callHtmlRoute(router, "/sitemap.xml");
        return r.status === 200 ? sitemapPaths(r.body) : [];
      };
      const providerPath = async (id: string): Promise<string> => {
        const r = await callHtmlRoute(router, `/tilbyder/${id}`);
        return r.status === 301 && r.location ? decodeURIComponent(r.location) : `/tilbyder/${id}`;
      };

      // ── (b) IDX-1: the store ───────────────────────────────────────────────
      {
        const combos = expStore.listProduktByCombos();
        const cell = (c: string, k: string) => combos.find((r) => r.category === c && r.kommune === k);
        const expected: Array<[string, string, number, number]> = [
          ["mat_drikke", "Bergen", 3, 0],
          ["natur_friluft", "Bergen", 3, 2],
          ["kultur_historie", "Bergen", 3, 1],
          ["natur_friluft", "Flakstad", 2, 0],
          ["dyreliv_safari", "Longyearbyen", 2, 2],
          ["natur_friluft", "Hitra", 2, 2],
        ];
        for (const [c, k, total, indexable] of expected) {
          const row = cell(c, k);
          const stats = expStore.getProduktByStats(c, k);
          assertTrue(!!row && row.total === total && row.indexableTotal === indexable,
            `ib-b1 (IDX-1): listProduktByCombos() ${c}/${k}: total ${total}, indexableTotal ${indexable} (got ${JSON.stringify(row)})`);
          assertTrue(stats.total === total && stats.indexableTotal === indexable && !!row
            && stats.providerCount === row.providerCount && stats.minPriceFrom === row.minPriceFrom,
            `ib-b2: getProduktByStats() ${c}/${k} agrees with the combo row (got ${JSON.stringify(stats)})`);
        }
        assertTrue(expStore.countIndexablePublishedExperiences({ kommune: "Bergen" }) === 3
          && expStore.countIndexablePublishedExperiences({ kommune: "Flakstad" }) === 0
          && expStore.countIndexablePublishedExperiences({ providerId: provMatA }) === 0
          && expStore.countIndexablePublishedExperiences({ providerId: provMatB }) === 1,
          "ib-b3: countIndexablePublishedExperiences() counts the rows shouldNoindexExperience() lets through, per kommune and per provider");
        assertTrue(expStore.countIndexablePublishedExperiences({}) === 0
          && expStore.countIndexablePublishedExperiences({ kommune: "" }) === 0
          && expStore.countIndexablePublishedExperiences({ category: "natur_friluft", kommune: "" }) === 0,
          "ib-b4: an empty filter or a blank value counts 0, never the whole catalog or the whole category");
        const byPlace = expStore.listIndexableCountsByPlace();
        assertTrue(byPlace.byKommune.get("Bergen") === 3 && !byPlace.byKommune.has("Flakstad")
          && byPlace.byProvider.get(provMatB) === 1 && !byPlace.byProvider.has(provMatA) && !byPlace.byProvider.has(provFlak),
          "ib-b5: listIndexableCountsByPlace() has the same counts, and no entry for a kommune or provider with none");
      }

      // ── (c) IDX-1 end to end ───────────────────────────────────────────────
      {
        const sm = await buildSitemap();
        const smCombos = sm.filter((p) => /^\/kategori\/[^/]+\/[^/]+$/.test(p) && !p.startsWith("/kategori/gardssalg/"));
        assertTrue(sameSet(smCombos, ["/kategori/natur_friluft/Bergen", "/kategori/dyreliv_safari/Longyearbyen", "/kategori/natur_friluft/Hitra"]),
          `ib-c1 (AC-B): the sitemap lists exactly the cells with ≥2 indexable experiences (got ${JSON.stringify(smCombos)})`);
        let listedOk = 0;
        for (const p of smCombos) {
          const [, , c, k] = p.split("/");
          if (expStore.getProduktByStats(c, k).indexableTotal >= 2) listedOk++;
        }
        assertTrue(listedOk === smCombos.length, `ib-c2 (AC-B): every combo in the sitemap has ≥2 indexable experiences (${listedOk}/${smCombos.length})`);

        for (const [c, label] of [["mat_drikke", "the repro (3 placeholders, 2 providers)"], ["kultur_historie", "3 published, 1 indexable"]] as const) {
          const r = await callHtmlRoute(router, comboUrl(c, "Bergen"));
          assertTrue(r.handled && r.status === 301 && r.location === "/kommune/Bergen",
            `ib-c3 (IDX-1): ${c}/Bergen — ${label} — answers 301 to /kommune/Bergen (got ${r.status} ${r.location})`);
        }
        const flak = await callHtmlRoute(router, comboUrl("natur_friluft", "Flakstad"));
        assertTrue(flak.status === 301 && flak.location === "/kommune/Flakstad",
          `ib-c4: a cell of placeholders only in another kommune answers 301 too (got ${flak.status} ${flak.location})`);

        const natur = await callHtmlRoute(router, comboUrl("natur_friluft", "Bergen"));
        assertTrue(natur.handled && natur.status === 200 && cardCount(natur.body) === 3,
          `ib-c5: natur_friluft/Bergen (2 indexable + 1 placeholder) is served and lists all 3 experiences (got ${natur.status}, ${cardCount(natur.body)} cards)`);
        const naturFaq = ldBlocks(natur.body).find((b) => b["@type"] === "FAQPage");
        assertTrue(!!naturFaq && naturFaq.mainEntity[0].acceptedAnswer.text.startsWith("Det er 3 opplevelser innen natur & friluft i Bergen"),
          "ib-c6: its FAQ states the 3 experiences the page lists (the facts stay over every published row)");

        const bergen = await callHtmlRoute(router, "/kommune/Bergen");
        assertTrue(same(linkedCombos(bergen.body), ["natur_friluft/Bergen"]),
          `ib-c7: /kommune/Bergen chips link only the served cell (got ${JSON.stringify(linkedCombos(bergen.body))})`);

        // A description lands on a mat_drikke placeholder: 1 indexable → still
        // 301; a second one → the cell passes the gate on the next request.
        db.prepare("UPDATE experiences SET description = ?, updated_at = datetime('now') WHERE id = ?").run(real("Bergen nabolagsmat"), matA1.id);
        let mat = await callHtmlRoute(router, comboUrl("mat_drikke", "Bergen"));
        assertTrue(mat.status === 301, "ib-c8: one described row is not enough (1 indexable) → still 301");
        db.prepare("UPDATE experiences SET description = ?, updated_at = datetime('now') WHERE title = ?").run(real("Food tours Bergen"), "Food tours Bergen");
        mat = await callHtmlRoute(router, comboUrl("mat_drikke", "Bergen"));
        assertTrue(mat.handled && mat.status === 200, `ib-c9: with 2 described rows the cell is served on the next request (got ${mat.status})`);
        const cachedChips = linkedCombos((await callHtmlRoute(router, "/kommune/Bergen")).body);
        assertTrue(!cachedChips.includes("mat_drikke/Bergen"), "ib-c10: within the TTL the /kommune chips use the cached combo list");
        seo.__resetProduktByCombosCacheForTesting();
        const freshChips = linkedCombos((await callHtmlRoute(router, "/kommune/Bergen")).body);
        assertTrue(freshChips.includes("mat_drikke/Bergen"), "ib-c11: after the cache is rebuilt the chip appears");
        assertTrue((await buildSitemap()).includes("/kategori/mat_drikke/Bergen"), "ib-c12: and the rebuilt sitemap lists the cell");
        // Back to the repro state for the rest of the file.
        db.prepare("UPDATE experiences SET description = NULL WHERE id = ?").run(matA1.id);
        db.prepare("UPDATE experiences SET description = '   ' WHERE title = ?").run("Food tours Bergen");
        seo.__resetProduktByCombosCacheForTesting();

        // Kill switch off: every row counts, as before IDX-1.
        setEnv(NOINDEX_ENV, "false");
        const off = await callHtmlRoute(router, comboUrl("mat_drikke", "Bergen"));
        assertTrue(off.status === 200, `ib-c13: OPPLEVAGENT_PLACEHOLDER_NOINDEX=false → the repro cell is served again (got ${off.status})`);
        assertTrue((await buildSitemap()).includes("/kategori/mat_drikke/Bergen"), "ib-c14: ...and listed again");
        setEnv(NOINDEX_ENV, undefined);
        seo.__resetProduktByCombosCacheForTesting();
      }

      // ── (d) IDX-2: /kommune and /tilbyder with placeholders only ───────────
      {
        const matAPath = await providerPath(provMatA);
        const flakPath = await providerPath(provFlak);
        const matBPath = await providerPath(provMatB);
        const sm = await buildSitemap();
        const noindexPages = ["/kommune/Flakstad", matAPath, flakPath];
        for (const p of noindexPages) {
          const r = await callHtmlRoute(router, encodeURI(p));
          assertTrue(r.handled && r.status === 200, `ib-d1 (IDX-2): ${p} still answers 200 (got ${r.status})`);
          assertTrue(r.body.includes(NOINDEX_META) && !r.body.includes(INDEX_META), `ib-d2: ${p} has <meta name="robots" content="noindex, follow">`);
          assertTrue(r.headers["x-robots-tag"] === "noindex, follow", `ib-d3: ${p} sends X-Robots-Tag: noindex, follow (got ${JSON.stringify(r.headers["x-robots-tag"])})`);
          assertTrue(cardCount(r.body) === 2, `ib-d4: ${p} still lists its experiences (noindex is not unpublishing)`);
          assertTrue(!sm.includes(p), `ib-d5: ${p} is not in the sitemap`);
        }
        for (const p of ["/kommune/Bergen", "/kommune/Vågan", matBPath]) {
          const r = await callHtmlRoute(router, encodeURI(p));
          assertTrue(r.status === 200 && r.body.includes(INDEX_META) && r.headers["x-robots-tag"] === undefined,
            `ib-d6: ${p} (≥1 indexable experience, even with placeholders beside it) stays index, no header`);
          assertTrue(sm.includes(p), `ib-d7: ${p} stays in the sitemap`);
        }
        const nordland = await callHtmlRoute(router, "/fylke/Nordland");
        assertTrue(nordland.body.includes('href="/kommune/Flakstad"'), "ib-d8: /fylke/Nordland still links the noindex kommune page");

        // A description lands → index on the next request, listed after the TTL.
        db.prepare("UPDATE experiences SET description = ?, updated_at = datetime('now') WHERE id = ?").run(real("Strandtur på Ramberg"), flak1.id);
        for (const p of ["/kommune/Flakstad", flakPath]) {
          const r = await callHtmlRoute(router, encodeURI(p));
          assertTrue(r.body.includes(INDEX_META) && r.headers["x-robots-tag"] === undefined, `ib-d9: ${p} is index on the next request once one experience is described`);
        }
        const cached = sitemapPaths(seo.getExperiencesSitemapXml());
        assertTrue(!cached.includes("/kommune/Flakstad"), "ib-d10: within the TTL the sitemap is the cached build");
        const rebuilt = sitemapPaths(seo.getExperiencesSitemapXml(Date.now() + 61 * 60_000));
        assertTrue(rebuilt.includes("/kommune/Flakstad") && rebuilt.includes(flakPath), "ib-d11: after the TTL the kommune and provider pages are listed again");
        db.prepare("UPDATE experiences SET description = NULL WHERE id = ?").run(flak1.id);

        // Kill switch off: every page index and listed, as before IDX-2.
        setEnv(NOINDEX_ENV, "false");
        const smOff = await buildSitemap();
        for (const p of noindexPages) {
          const r = await callHtmlRoute(router, encodeURI(p));
          assertTrue(r.body.includes(INDEX_META) && r.headers["x-robots-tag"] === undefined && smOff.includes(p),
            `ib-d12: OPPLEVAGENT_PLACEHOLDER_NOINDEX=false → ${p} is index and listed again`);
        }
        setEnv(NOINDEX_ENV, undefined);
        // The rest of the sitemap is untouched by the rule.
        const smOn = await buildSitemap();
        const kept = ["/fylke/Nordland", "/fylke/Vestland", "/kategori/natur_friluft", "/kategori/mat_drikke", `/opplevelse/${natur1.slug}`];
        assertTrue(kept.every((p) => smOn.includes(p)), `ib-d13: fylke, category and described detail pages stay listed (missing ${JSON.stringify(kept.filter((p) => !smOn.includes(p)))})`);
      }

      // ── (e) IDX-4: /proveniens ─────────────────────────────────────────────
      {
        const r = await callHtmlRoute(router, "/proveniens");
        assertTrue(r.status === 200 && r.body.includes('<link rel="canonical" href="https://opplevagent.no/proveniens">'),
          "ib-e1 (IDX-4): /proveniens has a self-referencing canonical");
        const desc = metaContent(r.body, "name", "description");
        assertTrue(!!desc && desc.length >= 70 && desc.length <= 170 && desc.includes("Brønnøysundregistrene"),
          `ib-e2: /proveniens has a meta description that names its source (got ${JSON.stringify(desc)})`);
        assertTrue(!!desc && !/sertifiser|certif|complian/i.test(desc), "ib-e3: the description makes no certification or compliance claim");
        const privacy = await callHtmlRoute(router, "/personvern");
        // Since I-P (MCP2-05) /personvern sends its own seo too; the full
        // check of it and its aliases is in seo-sidetekster.test.ts.
        assertTrue(privacy.status === 200 && (privacy.body.match(/rel="canonical"/g) || []).length === 1
          && privacy.body.includes('<link rel="canonical" href="https://opplevagent.no/personvern">'),
          "ib-e4: another legal page gets its own canonical, not /proveniens's");
      }

      // ── (f) SD-09: ItemList names = card titles ────────────────────────────
      {
        for (const p of ["/kommune/Bergen", "/fylke/Vestland", "/opplevelser", await providerPath(provNatur)]) {
          const r = await callHtmlRoute(router, encodeURI(p));
          const list = ldBlocks(r.body).find((b) => b["@type"] === "CollectionPage")?.mainEntity?.itemListElement ?? [];
          const names = list.map((i: any) => i.name);
          assertTrue(names.length > 0 && same(names, cardTitles(r.body)),
            `ib-f1 (SD-09): ${p}: ItemList names equal the card titles, in order (ld ${JSON.stringify(names)} vs cards ${JSON.stringify(cardTitles(r.body))})`);
        }
        const bergen = await callHtmlRoute(router, "/kommune/Bergen");
        const names = (ldBlocks(bergen.body).find((b) => b["@type"] === "CollectionPage")?.mainEntity?.itemListElement ?? []).map((i: any) => i.name);
        assertTrue(names.includes("Ulriken på tvers") && !names.includes("Ulriken Hike") && names.includes("Fløyen Sunset"),
          "ib-f2: a row with title_no is named by it; a row without falls back to title");
        const en = await callHtmlRoute(router, "/kommune/Bergen", "en");
        const enNames = (ldBlocks(en.body).find((b) => b["@type"] === "CollectionPage")?.mainEntity?.itemListElement ?? []).map((i: any) => i.name);
        assertTrue(enNames.includes("Ulriken Hike") && !enNames.includes("Ulriken på tvers") && same(enNames, cardTitles(en.body)),
          "ib-f3: on /en both the cards and the ItemList use the original title");
      }

      // ── (g) SD-11: gårdssalg hub and type pages ────────────────────────────
      {
        db.prepare(
          `INSERT INTO experience_providers
             (id, navn, vertical, fylke, kommune, poststed, producer_type, booking_live, catalog_hidden, lat, lon,
              geocode_confidence, slug, enrichment_state, verification_status, source, confidence)
           VALUES
             ('ib-gs1', 'Fjordbryggeriet', 'experiences', 'Vestland', 'Voss', 'Voss', 'bryggeri', 0, NULL, 60.63, 6.42,
              'high', 'ib-fjordbryggeriet', 'raw', 'pending_verify', 'test-fixture', 'medium')`,
        ).run();
        const pages = ["/kategori/gardssalg", "/kategori/gardssalg/bryggeri"];
        const OG_IMAGE = "https://opplevagent.no/og/gardssalg.png";
        for (const p of pages) {
          const r = await callHtmlRoute(router, p);
          const canonical = `https://opplevagent.no${p}`;
          const desc = metaContent(r.body, "name", "description");
          const title = (r.body.match(/<title>([^<]*)<\/title>/) || [])[1];
          assertTrue(r.status === 200 && metaContent(r.body, "property", "og:image") === OG_IMAGE,
            `ib-g1 (SD-11): ${p} has og:image ${OG_IMAGE} (got ${JSON.stringify(metaContent(r.body, "property", "og:image"))})`);
          assertTrue(metaContent(r.body, "property", "og:url") === canonical && metaContent(r.body, "property", "og:description") === desc
            && metaContent(r.body, "property", "og:title") === (title ? unescapeHtml(title) : null)
            && metaContent(r.body, "property", "og:image:width") === "1200" && metaContent(r.body, "property", "og:image:height") === "630"
            && metaContent(r.body, "property", "og:type") === "website" && metaContent(r.body, "property", "og:site_name") === "Opplevagent"
            && metaContent(r.body, "name", "twitter:card") === "summary_large_image",
            `ib-g2: ${p} og:url/title/description match canonical, <title> and meta description; twitter:card is summary_large_image`);
          assertTrue(!!desc && !/\bbook/i.test(desc) && /meld interesse/i.test(desc),
            `ib-g3: booking paused → ${p} meta description invites an interest request and never says «book» (got ${JSON.stringify(desc)})`);
          const hero = unescapeHtml((r.body.match(/<p class="hero-sub">([^<]*)<\/p>/) || [])[1] || "");
          assertTrue(!/\bbook/i.test(hero) && /meld interesse/i.test(hero),
            `ib-g4: booking paused → ${p} hero copy never says «book» (got ${JSON.stringify(hero)})`);
          assertTrue(r.body.includes("Meld interesse") && !r.body.includes(">Book besøk<"), `ib-g5: ${p}: the card CTA says «Meld interesse», matching the copy`);
        }
        const typeLd = ldBlocks((await callHtmlRoute(router, "/kategori/gardssalg/bryggeri")).body).find((b) => b["@type"] === "CollectionPage");
        assertTrue(!!typeLd && !/\bbook/i.test(typeLd.description), "ib-g6: the type page's CollectionPage description follows the paused copy");

        // Booking live for the vertical: a live provider AND the master switch.
        db.prepare("UPDATE experience_providers SET booking_live = 1 WHERE id = 'ib-gs1'").run();
        const stillPaused = metaContent((await callHtmlRoute(router, "/kategori/gardssalg")).body, "name", "description") || "";
        assertTrue(!/\bbook/i.test(stillPaused), "ib-g7: a booking_live provider with the dispatch master switch off keeps the paused copy");
        setEnv(DISPATCH_ENV, "true");
        for (const p of pages) {
          const r = await callHtmlRoute(router, p);
          const desc = metaContent(r.body, "name", "description") || "";
          const hero = unescapeHtml((r.body.match(/<p class="hero-sub">([^<]*)<\/p>/) || [])[1] || "");
          assertTrue(/\bbook/i.test(desc) && /\bbook/i.test(hero) && !/meld interesse/i.test(desc),
            `ib-g8: booking live → ${p} keeps the booking copy (meta ${JSON.stringify(desc)})`);
          assertTrue(metaContent(r.body, "property", "og:image") === OG_IMAGE, `ib-g9: ${p} has the same share card with booking live`);
        }
        setEnv(DISPATCH_ENV, undefined);
        const png = await callHtmlRoute(router, "/og/gardssalg.png");
        assertTrue(png.handled && png.status === 200, `ib-g10: the og:image URL is served (GET /og/gardssalg.png → ${png.status})`);
      }

      // ── (h) SD-12: the approximate-placement card on /opplevelse ───────────
      {
        const r = await callHtmlRoute(router, `/opplevelse/${hitra1.slug}`);
        assertTrue(r.status === 200 && r.body.includes("Omtrentlig plassering: Hitra"), "ib-h1: the kommune-precision row renders the approximate-placement card");
        assertTrue(r.body.includes("siden vi bare vet hvilken kommune tilbyderen ligger i.") && !r.body.includes("kommune produsenten ligger i"),
          "ib-h2 (SD-12): the card says «tilbyderen», never «produsenten»");
      }

      // ── (i) SD-13 on live pages ────────────────────────────────────────────
      {
        const sval = await callHtmlRoute(router, "/fylke/Svalbard");
        const visible = sval.body.replace(/<script[\s\S]*?<\/script>/g, "");
        assertTrue(sval.status === 200 && !/\bi Svalbard\b/.test(sval.body),
          `ib-i5 (SD-13): /fylke/Svalbard never says «i Svalbard» (${(sval.body.match(/.{0,40}\bi Svalbard\b.{0,20}/g) || []).join(" | ")})`);
        assertTrue(visible.includes("<title>Opplevelser på Svalbard | Opplevagent</title>") && visible.includes("<h1>Opplevelser på Svalbard</h1>"),
          "ib-i6: title and h1 say «på Svalbard»");
        assertTrue((metaContent(sval.body, "name", "description") || "").startsWith("Håndplukkede opplevelser og aktiviteter på Svalbard"),
          "ib-i7: the meta description says «på Svalbard»");
        assertTrue(visible.includes('aria-label="Kommuner på Svalbard"'), "ib-i8: the kommune chip row's aria-label says «på Svalbard»");
        assertTrue(visible.includes('<h2 id="fylke-map-h">Kart over opplevelser på Svalbard</h2>') && visible.includes('aria-label="Kart over 1 opplevelse på Svalbard"'),
          "ib-i8b: the fylke map's heading and aria-label say «på Svalbard»");
        const faq = ldBlocks(sval.body).find((b) => b["@type"] === "FAQPage");
        const ldPairs = (faq?.mainEntity ?? []).map((q: any) => [q.name, q.acceptedAnswer.text]);
        assertTrue(ldPairs.length === 4 && ldPairs[0][0] === "Hvor mange opplevelser finnes på Svalbard?" && same(visibleFaq(sval.body), ldPairs),
          `ib-i9: the FAQ asks «… på Svalbard?» and the visible FAQ equals the JSON-LD (got ${JSON.stringify(ldPairs)})`);
        const lede = unescapeHtml((sval.body.match(/<p class="lede">([^<]*)<\/p>/) || [])[1] || "");
        assertTrue(lede === "Opplevelser på Svalbard: 2 opplevelser i 1 kommune fordelt på 1 kategori hos 1 tilbyder, noen er gratis — håndplukket og verifisert mot Brønnøysundregistrene.",
          `ib-i10: the answer-first lede says «på Svalbard» and «noen er gratis» (got ${JSON.stringify(lede)})`);
        assertTrue(ldPairs[3]?.[1] === "Noen opplevelser på Svalbard er gratis — alle tilbydere er verifisert mot Brønnøysundregistrene." && !ZERO_KR.test(sval.body),
          "ib-i11 (0 kr): the FAQ price answer says «Noen opplevelser på Svalbard er gratis», and the page never says «0 kr»");

        const hitra = await callHtmlRoute(router, comboUrl("natur_friluft", "Hitra"));
        assertTrue(hitra.status === 200 && hitra.body.includes("<h1>Natur &amp; friluft på Hitra</h1>") && !/\bi Hitra\b/.test(hitra.body),
          "ib-i12: a combo page on Hitra says «på Hitra» and never «i Hitra»");
        const hitraFaq = ldBlocks(hitra.body).find((b) => b["@type"] === "FAQPage");
        assertTrue(hitraFaq?.mainEntity?.[0]?.name === "Hvor får jeg natur & friluft på Hitra?" && same(visibleFaq(hitra.body), hitraFaq.mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text])),
          "ib-i13: its FAQ asks «… på Hitra?», and the visible FAQ equals the JSON-LD");
        const hitraKommune = await callHtmlRoute(router, "/kommune/Hitra");
        assertTrue(hitraKommune.body.includes('aria-label="Kategorier på Hitra"') && hitraKommune.body.includes("<h1>Opplevelser på Hitra</h1>"),
          "ib-i14: /kommune/Hitra: h1 and the category chips' aria-label say «på Hitra»");
        const bergen = await callHtmlRoute(router, "/kommune/Bergen");
        assertTrue(bergen.body.includes("<h1>Opplevelser i Bergen</h1>") && bergen.body.includes('aria-label="Kategorier i Bergen"'),
          "ib-i15: /kommune/Bergen keeps «i Bergen» (regression)");
      }

      // ── (j) «fra 0 kr» on a category page ──────────────────────────────────
      {
        const r = await callHtmlRoute(router, "/kategori/dyreliv_safari");
        const lede = unescapeHtml((r.body.match(/<p class="lede">([^<]*)<\/p>/) || [])[1] || "");
        const faq = ldBlocks(r.body).find((b) => b["@type"] === "FAQPage");
        assertTrue(r.status === 200 && lede.includes(", noen er gratis — ") && !ZERO_KR.test(r.body),
          `ib-j10: /kategori/dyreliv_safari (cheapest 0) opens with «noen er gratis» and never says «0 kr» (got ${JSON.stringify(lede)})`);
        assertTrue(!!faq && same(visibleFaq(r.body), faq.mainEntity.map((q: any) => [q.name, q.acceptedAnswer.text])),
          "ib-j11: its visible FAQ still equals the JSON-LD");
        const detail = await callHtmlRoute(router, `/opplevelse/${sval1.slug}`);
        assertTrue(detail.body.includes('"price":1490'), "ib-j12: JSON-LD Offer prices stay numeric");
      }

      return { passed, failed, failures };
    } finally {
      setEnv("EXPERIENCES_DB_PATH", prev.db);
      setEnv(THRESHOLD_ENV, prev.threshold);
      setEnv(NOINDEX_ENV, prev.noindex);
      setEnv(DISPATCH_ENV, prev.dispatch);
      try {
        const seo = require("./experiences-seo") as typeof import("./experiences-seo");
        seo.__resetExperiencesSitemapCacheForTesting();
        seo.__resetProduktByCombosCacheForTesting();
      } catch { /* best-effort */ }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runExperiencesSeoIndeksTekstTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    for (const f of result.failures) console.log(f);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
