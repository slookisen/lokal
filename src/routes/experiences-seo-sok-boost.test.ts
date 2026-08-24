/**
 * experiences-seo-sok-boost.test.ts — dev-request
 * 2026-07-30-opplevagent-kategori-sok-og-reiserute-info.
 *
 * Covers, against the REAL opplevagent.no router (src/routes/experiences-seo.ts):
 *
 *   Goal 1 — category/fylke-boosted search. /kategori/:category and
 *   /fylke/:fylke's shared searchBox() now carries the current category/fylke
 *   through as a hidden field; /sok groups (never filters) its full-catalogue
 *   matches accordingly. Plain /sok / /opplevelser searches (no boost
 *   context) must stay byte-identical to before this feature existed.
 *
 *   Goal 2 — route-intent detection ported into opplevagent's /sok, reusing
 *   resolveRouteIntent()/reiseUrlFor() (route-intent.ts) and
 *   geocodingService.geocodePlaceForBackfill() AS-IS. A recognised route
 *   query 302-redirects to /reise?from=...&to=...; every failure path
 *   (no intent, weak-marker miss, geocoder outage) falls through to ordinary
 *   search instead.
 *
 *   Goal 3 — homepage hero hint (no/en) mentions the route-in-search-box
 *   capability and links to /reise, alongside the pre-existing copy.
 *
 * Same synthetic-req/res harness as experiences-seo-sok-geo.test.ts /
 * sok-search-honesty.test.ts (drives the real Express router directly, no
 * http listen()). geocodingService.geocodePlaceForBackfill is monkey-patched
 * to a small, deterministic place table (same technique route-intent.test.ts
 * uses for resolveRouteIntent itself) so route-intent tests need no network
 * access and no dependence on the real Kartverket API being reachable.
 *
 * Exported runExperiencesSeoSokBoostTests({log}) -> Promise<TestSummary>;
 * wired into tests/test.ts.
 * Standalone: npx tsx src/routes/experiences-seo-sok-boost.test.ts
 */

import { geocodingService } from "../services/geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

// Deterministic fake place table — mirrors route-intent.test.ts's own
// PLACES fixture, real enough coordinates that MIN_ROUTE_SEPARATION_KM
// (15 km) and the weak-marker floor (50 km) both behave exactly as they
// would against the real geocoder for these cities.
const FAKE_PLACES: Record<string, { lat: number; lng: number }> = {
  oslo: { lat: 59.9139, lng: 10.7522 },
  bergen: { lat: 60.3913, lng: 5.3221 },
  trondheim: { lat: 63.4305, lng: 10.3951 },
  bodø: { lat: 67.2804, lng: 14.4049 },
  bodo: { lat: 67.2804, lng: 14.4049 },
};

function callHtml(
  router: any,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; redirectedTo?: string }> {
  return new Promise((resolve) => {
    let statusCode = 200;
    const req: any = {
      method: "GET",
      url,
      originalUrl: url,
      path: url.split("?")[0],
      query: Object.fromEntries(new URLSearchParams(url.split("?")[1] || "")),
      headers,
      ip: "127.0.0.1",
      lang: "no",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { statusCode = code; this.statusCode = code; return this; },
      setHeader() { return this; },
      redirect(a: any, b?: any) {
        // Supports both res.redirect(url) and res.redirect(status, url) —
        // this router's own handlers use both forms.
        const status = typeof a === "number" ? a : 302;
        const location = typeof a === "number" ? b : a;
        resolve({ status, body: "", redirectedTo: location });
      },
      send(body: unknown) { resolve({ status: statusCode, body: String(body) }); },
    };
    router.handle(req, res, (err?: any) => {
      resolve({ status: statusCode, body: err ? String(err) : "" });
    });
  });
}

export async function runExperiencesSeoSokBoostTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ok ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }

  const prevExperiencesDbPath = process.env.EXPERIENCES_DB_PATH;
  process.env.EXPERIENCES_DB_PATH = ":memory:";

  const dbFactoryPath = require.resolve("../database/db-factory");
  const expStorePath = require.resolve("../services/experience-store");
  const seoPath = require.resolve("./experiences-seo");
  const cachePaths = [dbFactoryPath, expStorePath, seoPath];
  for (const p of cachePaths) delete require.cache[p];

  // Monkey-patch the SAME singleton experiences-seo.ts imports (geocoding-
  // service.ts's module cache entry is deliberately NOT cleared above, so
  // this is the one object the router's /sok handler will call into).
  const originalGeocodePlaceForBackfill = geocodingService.geocodePlaceForBackfill.bind(geocodingService);
  let geocodeShouldThrow = false;
  (geocodingService as any).geocodePlaceForBackfill = async (place: string) => {
    if (geocodeShouldThrow) throw new Error("simulated geocoder outage");
    const k = (place || "").toLowerCase().trim();
    const hit = FAKE_PLACES[k];
    return hit ? { lat: hit.lat, lng: hit.lng, name: place, radiusKm: 25, source: "hardcoded" as const } : null;
  };

  const prevLog = console.log;
  if (!log) console.log = () => { /* silence route/store chatter */ };

  try {
    const dbFactory = require("../database/db-factory") as typeof import("../database/db-factory");
    dbFactory.__resetDbFactoryForTesting();
    const expStore = require("../services/experience-store") as typeof import("../services/experience-store");
    dbFactory.getDb("experiences");

    const providerVestland = expStore.createProvider({
      navn: "Vestland Fjordopplevelser AS", fylke: "Vestland", kommune: "Bergen",
      brreg_verified: 1, brreg_active: 1, verification_status: "verified",
    });
    const providerMoreRomsdal = expStore.createProvider({
      navn: "Ålesund Safari AS", fylke: "Møre og Romsdal", kommune: "Ålesund",
      brreg_verified: 1, brreg_active: 1, verification_status: "verified",
    });

    // Matches "fjord", lives in category natur_friluft / fylke Vestland.
    expStore.createExperience({
      title: "Fjordtur i Bergen", provider_id: providerVestland,
      provider_match_status: "matched", kommune: "Bergen", fylke: "Vestland",
      category: "natur_friluft", verification_status: "verified", confidence: "high",
    });
    // Also matches "fjord", but a DIFFERENT category/fylke — the row that
    // must be grouped as "outside the current category/fylke", never dropped.
    expStore.createExperience({
      title: "Fjordsafari i Ålesund", provider_id: providerMoreRomsdal,
      provider_match_status: "matched", kommune: "Ålesund", fylke: "Møre og Romsdal",
      category: "dyreliv_safari", verification_status: "verified", confidence: "high",
    });
    // Does NOT match "fjord" at all — a control row proving the search itself
    // stays scoped to the query text, boost or no boost.
    expStore.createExperience({
      title: "Hvalsafari i Tromsø", provider_id: providerMoreRomsdal,
      provider_match_status: "matched", kommune: "Tromsø", fylke: "Troms og Finnmark",
      category: "dyreliv_safari", verification_status: "verified", confidence: "high",
    });

    const seoModule = require("./experiences-seo") as typeof import("./experiences-seo");
    const router = (seoModule as any).default;

    // ══════════════════════════════════════════════════════════════
    // Goal 1 — category/fylke boost grouping on /sok
    // ══════════════════════════════════════════════════════════════
    {
      const r = await callHtml(router, "/sok?q=fjord&category=natur_friluft");
      assertTrue(r.status === 200, `cat-1: GET /sok?q=fjord&category=natur_friluft renders 200 (got ${r.status})`);
      assertTrue(r.body.includes("Fjordtur i Bergen"), "cat-2: the in-category match is present");
      assertTrue(r.body.includes("Fjordsafari i Ålesund"), "cat-3: the out-of-category match is ALSO present (never filtered away)");
      assertTrue(!r.body.includes("Hvalsafari i Tromsø"), "cat-4: a non-matching row is still excluded by the text search itself");
      assertTrue(r.body.includes("Treff i Natur"), "cat-5: the in-category group renders its own distinct label");
      assertTrue(r.body.includes("Andre treff i Opplevagent"), "cat-6: the rest renders under the distinct 'Andre treff' label");
      const idxBoostLabel = r.body.indexOf("Treff i Natur");
      const idxInCat = r.body.indexOf("Fjordtur i Bergen");
      const idxRestLabel = r.body.indexOf("Andre treff i Opplevagent");
      const idxOutCat = r.body.indexOf("Fjordsafari i Ålesund");
      assertTrue(
        idxBoostLabel >= 0 && idxInCat >= 0 && idxRestLabel >= 0 && idxOutCat >= 0 &&
        idxBoostLabel < idxInCat && idxInCat < idxRestLabel && idxRestLabel < idxOutCat,
        `cat-7: rendering order is [boost label, in-category row, rest label, out-of-category row] (indices ${idxBoostLabel},${idxInCat},${idxRestLabel},${idxOutCat})`
      );
      assertTrue(r.body.includes('<meta name="robots" content="noindex, follow">'),
        "cat-8: /sok keeps its noindex, follow robots meta with the new params");
    }

    // ══════════════════════════════════════════════════════════════
    // Goal 1 — same treatment for fylke pages
    // ══════════════════════════════════════════════════════════════
    {
      const r = await callHtml(router, "/sok?q=fjord&fylke=Vestland");
      assertTrue(r.status === 200, `fylke-1: GET /sok?q=fjord&fylke=Vestland renders 200 (got ${r.status})`);
      assertTrue(r.body.includes("Treff i Vestland"), "fylke-2: the in-fylke group renders its own distinct label");
      assertTrue(r.body.includes("Andre treff i Opplevagent"), "fylke-3: the rest renders under 'Andre treff'");
      const idxBoostLabel = r.body.indexOf("Treff i Vestland");
      const idxInFylke = r.body.indexOf("Fjordtur i Bergen");
      const idxRestLabel = r.body.indexOf("Andre treff i Opplevagent");
      const idxOutFylke = r.body.indexOf("Fjordsafari i Ålesund");
      assertTrue(
        idxBoostLabel >= 0 && idxInFylke >= 0 && idxRestLabel >= 0 && idxOutFylke >= 0 &&
        idxBoostLabel < idxInFylke && idxInFylke < idxRestLabel && idxRestLabel < idxOutFylke,
        `fylke-4: rendering order is [boost label, in-fylke row, rest label, out-of-fylke row] (indices ${idxBoostLabel},${idxInFylke},${idxRestLabel},${idxOutFylke})`
      );
    }

    // ══════════════════════════════════════════════════════════════
    // Goal 1 — zero matches in the current category/fylke is never a dead
    // end: the rest of the catalogue's matches still render.
    // ══════════════════════════════════════════════════════════════
    {
      // "vinter_sno" has zero rows matching "fjord" — every match belongs
      // to the "Andre treff" group, and that group alone must still render.
      const r = await callHtml(router, "/sok?q=fjord&category=vinter_sno");
      assertTrue(r.status === 200, `zero-1: GET /sok?q=fjord&category=vinter_sno renders 200 (got ${r.status})`);
      assertTrue(!r.body.includes("Ingen treff"), "zero-2: does NOT render the empty state (the full-catalogue search DID have hits)");
      assertTrue(r.body.includes("Fjordtur i Bergen") && r.body.includes("Fjordsafari i Ålesund"),
        "zero-3: both real matches still render");
      assertTrue(!/Treff i Vinter/.test(r.body), "zero-4: no empty 'Treff i [category]' heading is rendered for a zero-hit boost group");
      assertTrue(r.body.includes("Andre treff i Opplevagent"), "zero-5: the rest is labelled as outside the current category");
    }

    // ══════════════════════════════════════════════════════════════
    // Regression — plain /sok search (no boost context) is UNCHANGED: one
    // flat, ungrouped list.
    // ══════════════════════════════════════════════════════════════
    {
      const r = await callHtml(router, "/sok?q=fjord");
      assertTrue(r.status === 200, `flat-1: GET /sok?q=fjord (no boost) renders 200 (got ${r.status})`);
      assertTrue(r.body.includes("Fjordtur i Bergen") && r.body.includes("Fjordsafari i Ålesund"),
        "flat-2: both matches present");
      assertTrue(!r.body.includes('class="search-group"'), "flat-3: no grouping markup at all — a single flat grid");
      assertTrue(!r.body.includes("Andre treff i Opplevagent"), "flat-4: no 'Andre treff' label without a boost context");
      assertTrue(!/Treff i /.test(r.body), "flat-5: no 'Treff i [x]' label without a boost context");
    }

    // ══════════════════════════════════════════════════════════════
    // Category/fylke pages pass the boost context through their searchBox()
    // (hidden field), and forward a stray ?q= on the page itself to /sok.
    // ══════════════════════════════════════════════════════════════
    {
      const r = await callHtml(router, "/kategori/natur_friluft");
      assertTrue(r.status === 200, `page-1: GET /kategori/natur_friluft renders 200 (got ${r.status})`);
      assertTrue(r.body.includes('name="category" value="natur_friluft"'),
        "page-2: the category page's searchBox() carries the category as a hidden field");
    }
    {
      const r = await callHtml(router, "/fylke/Vestland");
      assertTrue(r.status === 200, `page-3: GET /fylke/Vestland renders 200 (got ${r.status})`);
      assertTrue(r.body.includes('name="fylke" value="Vestland"'),
        "page-4: the fylke page's searchBox() carries the fylke as a hidden field");
    }
    {
      const r = await callHtml(router, "/kategori/natur_friluft?q=fjord");
      assertTrue(r.status === 302, `page-5: GET /kategori/natur_friluft?q=fjord redirects (got ${r.status})`);
      assertTrue(!!r.redirectedTo && r.redirectedTo.includes("/sok") && r.redirectedTo.includes("q=fjord") && r.redirectedTo.includes("category=natur_friluft"),
        `page-6: …to /sok with q + category carried through (got "${r.redirectedTo}")`);
    }
    {
      const r = await callHtml(router, "/fylke/Vestland?q=fjord");
      assertTrue(r.status === 302, `page-7: GET /fylke/Vestland?q=fjord redirects (got ${r.status})`);
      assertTrue(!!r.redirectedTo && r.redirectedTo.includes("/sok") && r.redirectedTo.includes("q=fjord") && r.redirectedTo.includes("fylke=Vestland"),
        `page-8: …to /sok with q + fylke carried through (got "${r.redirectedTo}")`);
    }
    {
      // Regression: /opplevelser's own searchBox() carries no boost context
      // at all — must render exactly as before this feature existed.
      const r = await callHtml(router, "/opplevelser");
      assertTrue(r.status === 200, `page-9: GET /opplevelser renders 200 (got ${r.status})`);
      assertTrue(!r.body.includes('name="category"') && !r.body.includes('name="fylke"'),
        "page-10: /opplevelser's search box carries no boost hidden field");
    }

    // ══════════════════════════════════════════════════════════════
    // Goal 2 — route-intent detection on /sok
    // ══════════════════════════════════════════════════════════════
    // NOTE: route-intent.ts's own norm() lowercases the whole query before
    // splitting it into endpoints (see detectRouteIntent) — route.from/to.query
    // is therefore lowercase by design (route-intent.test.ts's ri14 pins the
    // same "oslo", not "Oslo"). Reused as-is here, not reimplemented, so the
    // redirect target is lowercase too — exactly what rettfrabonden.com's own
    // /sok already produces from the SAME shared module.
    {
      const r = await callHtml(router, "/sok?q=" + encodeURIComponent("Oslo til Bergen"));
      assertTrue(r.status === 302, `ri-1: GET /sok?q=Oslo til Bergen redirects (got ${r.status})`);
      assertTrue(r.redirectedTo === "/reise?from=oslo&to=bergen",
        `ri-2: …exactly to /reise?from=oslo&to=bergen (got "${r.redirectedTo}")`);
    }
    {
      const r = await callHtml(router, "/sok?q=" + encodeURIComponent("fra Oslo til Bergen"));
      assertTrue(r.status === 302 && r.redirectedTo === "/reise?from=oslo&to=bergen",
        `ri-3: "fra X til Y" phrasing also redirects (got status ${r.status}, location "${r.redirectedTo}")`);
    }
    {
      const r = await callHtml(router, "/sok?q=" + encodeURIComponent("Oslo → Bergen"));
      assertTrue(r.status === 302 && r.redirectedTo === "/reise?from=oslo&to=bergen",
        `ri-4: "X → Y" arrow phrasing also redirects (got status ${r.status}, location "${r.redirectedTo}")`);
    }
    {
      const r = await callHtml(router, "/sok?q=" + encodeURIComponent("Oslo to Bergen"));
      assertTrue(r.status === 302 && r.redirectedTo === "/reise?from=oslo&to=bergen",
        `ri-5: English "X to Y" phrasing also redirects (got status ${r.status}, location "${r.redirectedTo}")`);
    }
    {
      // Weak dash marker on a producer-name-shaped query, mirroring the live
      // catalogue's own «Navn — Sted» convention (route-intent.ts's module
      // header) — must NOT be hijacked. Neither side geocodes under the fake
      // resolver (as neither would under the real strict one), so
      // resolveRouteIntent rejects it and /sok runs its ordinary search.
      const r = await callHtml(router, "/sok?q=" + encodeURIComponent("Fjordtur i Bergen - Gårdsutsalg"));
      assertTrue(r.status === 200, `ri-6: a dash query shaped like a producer name is NOT redirected (got ${r.status})`);
      assertTrue(!r.redirectedTo, `ri-7: …no redirect at all (got "${r.redirectedTo}")`);
    }
    {
      // Simulated geocoder outage on an otherwise-valid route query — must
      // degrade to ordinary search, never a thrown error / 500.
      geocodeShouldThrow = true;
      try {
        const r = await callHtml(router, "/sok?q=" + encodeURIComponent("Oslo til Bergen"));
        assertTrue(r.status === 200, `ri-8: a geocoder outage on a route-shaped query falls through to ordinary search, 200 (got ${r.status})`);
        assertTrue(!r.redirectedTo, `ri-9: …and does NOT redirect (got "${r.redirectedTo}")`);
      } finally {
        geocodeShouldThrow = false;
      }
    }
    {
      // A category-boosted search must not be short-circuited by the
      // route-intent check for an ordinary (non-route) query — both features
      // compose: "fjord" isn't route-shaped, so boosting still runs.
      const r = await callHtml(router, "/sok?q=fjord&category=natur_friluft");
      assertTrue(r.status === 200 && !r.redirectedTo, "ri-10: an ordinary boosted search is unaffected by the route-intent check");
    }

    // ══════════════════════════════════════════════════════════════
    // Goal 3 — homepage hero hint mentions the route-in-search-box
    // capability (NO + EN), while preserving the pre-existing copy.
    // ══════════════════════════════════════════════════════════════
    {
      const homeStrings = (seoModule as any).homeStrings as (lang: "no" | "en") => Record<string, string>;
      const no = homeStrings("no");
      const en = homeStrings("en");
      assertTrue(typeof no.hintRoutePre === "string" && no.hintRoutePre.length > 0, "hero-1: no locale has a route hint string");
      assertTrue(typeof en.hintRoutePre === "string" && en.hintRoutePre.length > 0, "hero-2: en locale has a route hint string");
      assertTrue(/oslo/i.test(no.hintRouteLink) && /bergen/i.test(no.hintRouteLink), "hero-3: no route hint gives a concrete route example");
      assertTrue(/oslo/i.test(en.hintRouteLink) && /bergen/i.test(en.hintRouteLink), "hero-4: en route hint gives a concrete route example");
      // Pre-existing copy (bla i alle opplevelser / browse all experiences)
      // must be preserved verbatim. The /api/opplevelser/discover mention
      // that used to sit in this same hint line is GONE as of Daniel's
      // 2026-08-24 UX pass, punkt 1 — «gir ikke mening for de fleste uten
      // ai kunnskap» — see hero-10/hero-11 below.
      assertTrue(no.hintLink === "bla i alle opplevelser", "hero-5: no 'browse all experiences' copy preserved verbatim");
      assertTrue(en.hintLink === "browse all experiences", "hero-6: en 'browse all experiences' copy preserved verbatim");
    }
    {
      const r = await callHtml(router, "/");
      assertTrue(r.status === 200, `hero-7: GET / renders 200 (got ${r.status})`);
      assertTrue(r.body.includes('href="/reise"'), "hero-8: the homepage hero links to /reise");
      assertTrue(r.body.includes(">bla i alle opplevelser<") || r.body.includes("bla i alle opplevelser"),
        "hero-9: the existing 'browse all experiences' hint is still rendered");
      const heroHint = (r.body.match(/<p class="discover-hint">[\s\S]*?<\/p>/) || [""])[0];
      assertTrue(heroHint.length > 0 && !/api\/opplevelser\/discover/.test(heroHint),
        "hero-10: the hero hint no longer puts a raw REST endpoint in front of human visitors");
      // …but the endpoint itself is NOT hidden from agents: the homepage's own
      // "For AI-agenter" code-card still documents the same call.
      assertTrue(/<span class="pth">\/api\/opplevelser\/discover<\/span>/.test(r.body),
        "hero-11: the agents section still documents GET /api/opplevelser/discover");
    }
  } catch (err: any) {
    failed++;
    failures.push("experiences-seo-sok-boost: unexpected error: " + String(err?.stack || err?.message || err));
  } finally {
    console.log = prevLog;
    (geocodingService as any).geocodePlaceForBackfill = originalGeocodePlaceForBackfill;
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
}

if (require.main === module) {
  runExperiencesSeoSokBoostTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
