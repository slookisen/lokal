/**
 * experiences-seo-indexability.test.ts — dev-request
 * 2026-10-16-opplevagent-indekserbarhet-og-strukturdata, E1-S1: one
 * indexability rule (services/experience-indexability.ts) drives
 * /opplevelse/<slug>'s robots meta, its X-Robots-Tag header and its
 * sitemap.xml entry, so the three can never disagree.
 *
 * Covers:
 *   (a) the predicate: missing / blank / junk description → not indexable;
 *       real prose and a faktalinje → indexable; the kill switch
 *       OPPLEVAGENT_PLACEHOLDER_NOINDEX is on unless it is exactly "false".
 *   (b) switch on (default): a placeholder page (no, blank or junk
 *       description) answers 200 with `noindex, follow` in the meta tag AND
 *       the X-Robots-Tag header and is not in the sitemap; a described page
 *       (incl. faktalinje) is `index` with no X-Robots-Tag and is listed.
 *       AC1 in code: no listed /opplevelse/ page shows the placeholder text
 *       or carries noindex.
 *   (c) noindex is not unpublishing (Daniel's scope choice 2026-09-18,
 *       alt. C): the placeholder page is still linked from its category page.
 *   (d) AC4: once a description is written onto a placeholder row, the page
 *       is `index` on the next request and back in the sitemap after the
 *       sitemap cache TTL.
 *   (e) OPPLEVAGENT_PLACEHOLDER_NOINDEX="false": the pre-E1-S1 behaviour —
 *       every page `index, follow…`, no header, every page listed.
 *
 * Run standalone: npx tsx src/routes/experiences-seo-indexability.test.ts
 * Wired into `npm test` via tests/test.ts.
 */

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

const PLACEHOLDER_TEXT = "Detaljert beskrivelse publiseres fortløpende";
const NOINDEX_META = '<meta name="robots" content="noindex, follow">';
const INDEX_META = '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">';
// The Homme Gård case from description-quality.ts's module doc: skip-link +
// nav menu + contact block scraped as a "description".
const JUNK_DESCRIPTION =
  "Skip to content Homme 8, 4715 Øvrebø 41360545 john@hommegaard.no Facebook-f Instagram Forside Gårdsutsalg Produksjon Meny";

type RouteResult = { handled: boolean; status: number; body: string; headers: Record<string, string> };

// Same synthetic router.handle() shortcut as this route's sibling .test.ts
// files (experiences-seo-visning-mcp-tilbyder.test.ts, …), plus header capture.
function callHtmlRoute(router: any, url: string): Promise<RouteResult> {
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
      lang: "no",
      get() { return undefined; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = String(v); },
      redirect(code: number, loc: string) { resolve({ handled: true, status: code, body: loc, headers }); },
      send(body: unknown) { resolve({ handled: true, status: statusCode, body: String(body), headers }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ handled: false, status: statusCode, body: err ? String(err) : "", headers });
    });
  });
}

/** Every /opplevelse/<slug> slug listed in a sitemap body. */
function sitemapDetailSlugs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>[^<]*\/opplevelse\/([^<]+)<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(decodeURIComponent(m[1]));
  return out;
}

export function runExperiencesSeoIndexabilityTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  return (async () => {
    const prevDb = process.env.EXPERIENCES_DB_PATH;
    const prevNoindex = process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX;
    process.env.EXPERIENCES_DB_PATH = ":memory:";
    delete process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX;

    const paths = [
      require.resolve("../database/db-factory"),
      require.resolve("../services/experience-store"),
      require.resolve("./experiences-seo"),
    ];
    const restoreModuleCache = (require("../../tests/module-cache") as typeof import("../../tests/module-cache")).swapOutModules(paths);

    try {
      // ── (a) the predicate and the kill switch ──────────────────────────────
      const ix = require("../services/experience-indexability") as typeof import("../services/experience-indexability");
      assertTrue(!ix.isExperienceIndexable({ description: null }), "ix-a1: null description → not indexable");
      assertTrue(!ix.isExperienceIndexable({}), "ix-a2: missing description → not indexable");
      assertTrue(!ix.isExperienceIndexable({ description: "" }), "ix-a3: empty description → not indexable");
      assertTrue(!ix.isExperienceIndexable({ description: "   \n\t " }), "ix-a4: whitespace-only description → not indexable");
      assertTrue(!ix.isExperienceIndexable({ description: JUNK_DESCRIPTION }), "ix-a5: scraped nav/contact junk → not indexable");
      assertTrue(ix.isExperienceIndexable({ description: "Guidet kajakktur i Lysefjorden for hele familien." }), "ix-a6: real prose → indexable");
      assertTrue(ix.renderableExperienceDescription(" Ekte tekst med mellomrom. ") === " Ekte tekst med mellomrom. ",
        "ix-a7: a renderable description is returned unchanged (page text byte-identical to before)");
      assertTrue(ix.renderableExperienceDescription(JUNK_DESCRIPTION) === "" && ix.renderableExperienceDescription(null) === "",
        "ix-a8: junk / missing → \"\" (the page falls back to the placeholder)");
      const flagCases: Array<[string | undefined, boolean]> = [[undefined, true], ["", true], ["true", true], ["0", true], ["FALSE", true], ["false", false]];
      for (const [value, expected] of flagCases) {
        if (value === undefined) delete process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX;
        else process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX = value;
        assertTrue(ix.isPlaceholderNoindexEnabled() === expected,
          `ix-a9: OPPLEVAGENT_PLACEHOLDER_NOINDEX=${JSON.stringify(value)} → switch ${expected ? "on" : "off"}`);
        assertTrue(ix.shouldNoindexExperience({ description: null }) === expected,
          `ix-a10: placeholder row with OPPLEVAGENT_PLACEHOLDER_NOINDEX=${JSON.stringify(value)} → noindex=${expected}`);
        assertTrue(ix.shouldNoindexExperience({ description: "Ekte beskrivelse av opplevelsen." }) === false,
          `ix-a11: described row with OPPLEVAGENT_PLACEHOLDER_NOINDEX=${JSON.stringify(value)} → never noindex`);
      }
      delete process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX;

      // ── fixtures ───────────────────────────────────────────────────────────
      const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
      dbFactory.__resetDbFactoryForTesting();
      const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
      const db = dbFactory.getDb("experiences") as any;
      const seo = require("./experiences-seo") as typeof import("./experiences-seo");
      const router = seo.default as any;

      const provId = expStore.createProvider({
        navn: "Lysefjorden Padling AS", org_nr: "912345670",
        fylke: "Rogaland", kommune: "Strand", hjemmeside: "https://padling.example.no",
        brreg_verified: 1, brreg_active: 1, verification_status: "verified",
      });
      const mk = (title: string, description: string | null): string => {
        const id = expStore.createExperience({
          title, provider_id: provId, provider_match_status: "matched",
          category: "natur_friluft", fylke: "Rogaland", kommune: "Strand", indoor_outdoor: "outdoor",
          ...(description !== null ? { description } : {}),
          confidence: "high", verification_status: "verified",
        });
        return (expStore.getExperienceById(id) as any).slug as string;
      };
      const realSlug = mk("Kajakktur i Lysefjorden", "Guidet kajakktur i Lysefjorden med erfarne guider og alt utstyr inkludert.");
      const faktaSlug = mk("Fjordpadling for nybegynnere", "Padletur på fjorden med guide, passer for nybegynnere.");
      db.prepare("UPDATE experiences SET content_field_evidence = ? WHERE slug = ?")
        .run(JSON.stringify({ description: "generated:katalogfelt-llm" }), faktaSlug);
      const noneSlug = mk("Preikestolen ved soloppgang", null);
      const blankSlug = mk("Fjellvandring til Kjerag", "   ");
      const junkSlug = mk("Gårdsbesøk i Strand", JUNK_DESCRIPTION);
      const indexable = [realSlug, faktaSlug];
      const placeholders = [noneSlug, blankSlug, junkSlug];

      // ── (b) switch on: page meta + header + sitemap agree ──────────────────
      for (const slug of placeholders) {
        const r = await callHtmlRoute(router, `/opplevelse/${slug}`);
        assertTrue(r.handled && r.status === 200, `ix-b1: placeholder page /opplevelse/${slug} still answers 200 (got ${r.status})`);
        assertTrue(r.body.includes(PLACEHOLDER_TEXT), `ix-b2: ${slug} renders the placeholder`);
        assertTrue(r.body.includes(NOINDEX_META), `ix-b3: ${slug} has <meta name="robots" content="noindex, follow">`);
        assertTrue(!r.body.includes(INDEX_META), `ix-b4: ${slug} has no index robots meta`);
        assertTrue(r.headers["x-robots-tag"] === "noindex, follow", `ix-b5: ${slug} sends X-Robots-Tag: noindex, follow (got ${JSON.stringify(r.headers["x-robots-tag"])})`);
      }
      for (const slug of indexable) {
        const r = await callHtmlRoute(router, `/opplevelse/${slug}`);
        assertTrue(r.handled && r.status === 200, `ix-b6: described page /opplevelse/${slug} answers 200`);
        assertTrue(!r.body.includes(PLACEHOLDER_TEXT), `ix-b7: ${slug} does not render the placeholder`);
        assertTrue(r.body.includes(INDEX_META), `ix-b8: ${slug} keeps the index robots meta`);
        assertTrue(!r.body.includes("noindex"), `ix-b9: ${slug} has no noindex anywhere`);
        assertTrue(r.headers["x-robots-tag"] === undefined, `ix-b10: ${slug} sends no X-Robots-Tag`);
      }
      {
        const r = await callHtmlRoute(router, `/opplevelse/${faktaSlug}`);
        assertTrue(r.body.includes("Automatisk sammendrag fra katalogdata"),
          "ix-b11: the faktalinje fixture is a faktalinje (badge shown) and still indexable");
      }

      seo.__resetExperiencesSitemapCacheForTesting();
      const sm = await callHtmlRoute(router, "/sitemap.xml");
      assertTrue(sm.handled && sm.status === 200, "ix-b12: GET /sitemap.xml → 200");
      const listed = sitemapDetailSlugs(sm.body);
      for (const slug of indexable) assertTrue(listed.includes(slug), `ix-b13: sitemap lists the described page ${slug}`);
      for (const slug of placeholders) assertTrue(!listed.includes(slug), `ix-b14: sitemap leaves out the placeholder page ${slug}`);
      assertTrue(listed.length === indexable.length, `ix-b15: sitemap lists exactly the ${indexable.length} indexable detail pages (got ${listed.length})`);
      assertTrue(sm.body.includes("/kategori/natur_friluft<"), "ix-b16: the category page is still listed (only detail pages are filtered)");
      // AC1 in code: no listed detail page shows the placeholder or is noindex.
      let listedClean = 0;
      for (const slug of listed) {
        const r = await callHtmlRoute(router, `/opplevelse/${slug}`);
        if (r.status === 200 && !r.body.includes(PLACEHOLDER_TEXT) && !r.body.includes(NOINDEX_META) && r.headers["x-robots-tag"] === undefined) listedClean++;
      }
      assertTrue(listed.length > 0 && listedClean === listed.length,
        `ix-b17: every sitemap /opplevelse/ page is indexable and placeholder-free (${listedClean}/${listed.length})`);

      // ── (c) noindex is not unpublishing ────────────────────────────────────
      {
        const r = await callHtmlRoute(router, "/kategori/natur_friluft");
        assertTrue(r.handled && r.status === 200, "ix-c1: category page renders");
        for (const slug of placeholders) {
          assertTrue(r.body.includes(`href="/opplevelse/${slug}"`), `ix-c2: category page still links the noindex page ${slug}`);
        }
      }

      // ── (d) AC4: a description lands → index again, listed after the TTL ──
      db.prepare("UPDATE experiences SET description = ?, updated_at = datetime('now') WHERE slug = ?")
        .run("Soloppgangstur til Preikestolen med guide, hodelykt og varm drikke.", noneSlug);
      {
        const r = await callHtmlRoute(router, `/opplevelse/${noneSlug}`);
        assertTrue(r.body.includes(INDEX_META) && r.headers["x-robots-tag"] === undefined && !r.body.includes(PLACEHOLDER_TEXT),
          "ix-d1: once described, the page is index (meta + no header) on the very next request");
        const cached = seo.getExperiencesSitemapXml();
        assertTrue(!sitemapDetailSlugs(cached).includes(noneSlug), "ix-d2: within the cache TTL the sitemap is the cached build");
        const rebuilt = seo.getExperiencesSitemapXml(Date.now() + 61 * 60_000);
        assertTrue(sitemapDetailSlugs(rebuilt).includes(noneSlug), "ix-d3: after the cache TTL the newly described page is listed again");
      }

      // ── (e) kill switch off: the pre-E1-S1 behaviour ───────────────────────
      process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX = "false";
      for (const slug of [blankSlug, junkSlug]) {
        const r = await callHtmlRoute(router, `/opplevelse/${slug}`);
        assertTrue(r.status === 200 && r.body.includes(PLACEHOLDER_TEXT), `ix-e1: ${slug} still renders the placeholder with the switch off`);
        assertTrue(r.body.includes(INDEX_META) && !r.body.includes(NOINDEX_META), `ix-e2: ${slug} is index, follow with the switch off`);
        assertTrue(r.headers["x-robots-tag"] === undefined, `ix-e3: ${slug} sends no X-Robots-Tag with the switch off`);
      }
      seo.__resetExperiencesSitemapCacheForTesting();
      {
        const listedOff = sitemapDetailSlugs((await callHtmlRoute(router, "/sitemap.xml")).body);
        const all = [realSlug, faktaSlug, noneSlug, blankSlug, junkSlug];
        assertTrue(all.every((s) => listedOff.includes(s)) && listedOff.length === all.length,
          `ix-e4: with the switch off the sitemap lists every published detail page again (got ${listedOff.length}/${all.length})`);
      }

      return { passed, failed, failures };
    } finally {
      if (prevDb === undefined) delete process.env.EXPERIENCES_DB_PATH; else process.env.EXPERIENCES_DB_PATH = prevDb;
      if (prevNoindex === undefined) delete process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX; else process.env.OPPLEVAGENT_PLACEHOLDER_NOINDEX = prevNoindex;
      try {
        (require("./experiences-seo") as typeof import("./experiences-seo")).__resetExperiencesSitemapCacheForTesting();
      } catch { /* best-effort */ }
      try {
        (require("../database/db-factory") as typeof import("../database/db-factory")).__resetDbFactoryForTesting();
      } catch { /* best-effort */ }
      restoreModuleCache();
    }
  })();
}

if (require.main === module) {
  runExperiencesSeoIndexabilityTests({ log: true }).then((result) => {
    console.log(`\n${result.passed} passed, ${result.failed} failed`);
    for (const f of result.failures) console.log(f);
    process.exit(result.failed > 0 ? 1 : 0);
  });
}
