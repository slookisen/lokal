/**
 * marketplace-search-honesty.test.ts — dev-request
 * 2026-07-25-reisesok-korridor-discovery-og-naerhetssok, Fase 0 fixes
 * 0b / 0d / 0e / 0f / 0g(ii).
 *
 * Every case below is a search result that ACTIVELY MISLED users in
 * production on 2026-07-25 (all four symptoms measured live against
 * rettfrabonden.com that day):
 *
 *   0b  `honning Vadsø` → 0 hits in Vadsø → the auto-expand ladder dropped the
 *       geo filter entirely and returned Tønsberg / Melhus / Røros, while the
 *       response still said geoFiltered:true, geoSource:"hardcoded" and
 *       carried no note. The expansion built a NEW query object and never
 *       cleared `parsed.location`, so the reporting line could not know.
 *
 *   0d  `gårdsutsalg i Agder` → Sørum (277 km), Stange (318 km), Stavanger
 *       (120 km) all at relevanceScore 0.750, with the single real Agder
 *       producer ranked 6th. Any query containing gård/bakeri/marked/… set
 *       _nameQuery and took a branch that skipped geo SQL entirely and gave
 *       every hit the same flat score.
 *
 *   0e  `nær meg` → nationwide trust-ranked list, geoFiltered:false, no
 *       signal. «nær», «meg», «her», «hvor» are all stopwords, so the query
 *       parsed to nothing at all.
 *
 *   0f  Proximity search was impossible without typing text: the endpoint
 *       hard-400'd without ?q=.
 *
 *   0g(ii) SECURITY — the endpoint auto-started up to 2 seller conversations
 *       for every JSON-accepting client, i.e. for every MCP/AI caller, even
 *       though `lokal_search` / `lokal_discover` declare readOnlyHint:true.
 *
 * Harness mirrors admin-blocklist-manual-entry.test.ts (real init.ts schema in
 * an in-memory DB, the REAL router exercised through router.handle(), no
 * supertest, no network) — except the /search handler is async, so the caller
 * returns a promise resolved from res.json(). The geocoder's HTTP seam is
 * stubbed via __setGeocodingFetchForTesting so no Kartverket call is made.
 *
 * Exported runMarketplaceSearchHonestyTests({log}) -> TestSummary; wired into
 * tests/test.ts. Standalone: npx tsx src/routes/marketplace-search-honesty.test.ts
 */

import Database from "better-sqlite3";
import { __setDbForTesting, __initSchemaForTesting } from "../database/init";
import {
  __setGeocodingFetchForTesting,
  __clearGeocodeCacheForTesting,
} from "../services/geocoding-service";

export interface TestSummary {
  passed: number;
  failed: number;
  failures: string[];
}

interface RouteResult {
  status: number;
  body: any;
}

function callRoute(
  router: any,
  opts: { method?: string; url: string; query?: Record<string, string>; headers?: Record<string, string> },
): Promise<RouteResult> {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const req: any = {
      method: opts.method || "GET",
      url: opts.url,
      query: opts.query || {},
      headers,
      ip: "127.0.0.1",
      get(name: string) { return headers[name.toLowerCase()]; },
    };
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      setHeader() { return this; },
      send(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    router.handle(req, res, (err?: any) => {
      if (err) resolve({ status: 500, body: { error: String(err) } });
    });
  });
}

// ── Test fixture: five producers whose positions reproduce the live bugs ──
// Coordinates are the real ones for these towns.
const AGDER = { lat: 58.5, lng: 7.5 };           // MAJOR_CITIES "agder", radius 90
const VADSO = { lat: 70.0803, lng: 29.7309 };    // MAJOR_CITIES "vadsø", radius 25

interface SeedAgent {
  id: string; name: string; city: string; lat: number | null; lng: number | null;
  categories: string[]; trust: number;
}

const SEED: SeedAgent[] = [
  // 0d — one real Agder producer, three high-trust far-away namesakes.
  { id: "a-agder",     name: "Sørlandet Gårdsutsalg", city: "Lyngdal",   lat: 58.1376, lng: 7.0700,  categories: [],        trust: 0.40 },
  { id: "a-sorum",     name: "Sørum Gårdsutsalg",     city: "Sørum",     lat: 59.9833, lng: 11.2333, categories: [],        trust: 0.95 },
  { id: "a-stange",    name: "Stange Gårdsutsalg",    city: "Stange",    lat: 60.7167, lng: 11.1833, categories: [],        trust: 0.93 },
  { id: "a-stavanger", name: "Stavanger Gårdsutsalg", city: "Stavanger", lat: 58.9700, lng: 5.7331,  categories: [],        trust: 0.90 },
  // 0b — honey producers, none anywhere near Vadsø.
  { id: "a-honning-1", name: "Tønsberg Birøkt",       city: "Tønsberg",  lat: 59.2675, lng: 10.4076, categories: ["honey"], trust: 0.80 },
  { id: "a-honning-2", name: "Melhus Honning",        city: "Melhus",    lat: 63.2833, lng: 10.2833, categories: ["honey"], trust: 0.78 },
  { id: "a-honning-3", name: "Røros Honning",         city: "Røros",     lat: 62.5743, lng: 11.3834, categories: ["honey"], trust: 0.76 },
];

function seedAgents(db: Database.Database): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents
      (id, name, description, provider, contact_email, url, version, role, api_key,
       lat, lng, city, radius_km, categories, tags, skills, capabilities, languages,
       trust_score, is_active, is_verified, discovery_count, interaction_count,
       total_interactions, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, '1.0.0', 'producer', ?, ?, ?, ?, NULL, ?, '[]', '[]', '{}', '["no"]',
            ?, 1, 0, 0, 0, 0, datetime('now'), datetime('now'))
  `);
  for (const a of SEED) {
    stmt.run(
      a.id, a.name, "Lokal produsent", "test", `${a.id}@example.no`, `https://${a.id}.example.no`,
      "key-" + a.id, a.lat, a.lng, a.city, JSON.stringify(a.categories), a.trust,
    );
  }
}

/** Geocoder stub: only the two hardcoded places these tests need are ever hit. */
function stubGeocoder(): void {
  const notFound = () => ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
  __setGeocodingFetchForTesting((async () => notFound()) as unknown as typeof fetch);
  __clearGeocodeCacheForTesting();
}

export async function runMarketplaceSearchHonestyTests(opts: { log?: boolean } = {}): Promise<TestSummary> {
  const log = opts.log ?? false;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  function assertTrue(cond: boolean, label: string): void {
    if (cond) { passed++; if (log) console.log(`  ✓ ${label}`); }
    else { failed++; failures.push(`✗ ${label}`); if (log) console.log(`  ✗ ${label}`); }
  }
  function assertEq(actual: unknown, expected: unknown, label: string): void {
    assertTrue(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }

  const db = new Database(":memory:");
  db.pragma("journal_mode = DELETE");
  db.pragma("foreign_keys = ON");
  __setDbForTesting(db as any);
  __initSchemaForTesting(db as any);
  seedAgents(db);
  stubGeocoder();

  const prevLogLevel = console.log;
  if (!log) console.log = () => { /* silence the registry's name-search chatter */ };

  try {
    const router = require("./marketplace").default;
    const { marketplaceRegistry } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");
    const { isProximityIntent } = require("../services/marketplace-registry") as
      typeof import("../services/marketplace-registry");
    const { buildSearchNote, resolveSearchRadiusKm, isValidLatLng } = require("../utils/geo-query") as
      typeof import("../utils/geo-query");

    const convCount = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM conversations").get() as { n: number }).n;

    // ════════════════════════════════════════════════════════════════
    // 0b — a geo-dropped result set must not claim to be geo-filtered
    // ════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(router, { url: "/search", query: { q: "honning Vadsø" } });
      assertEq(r.status, 200, "0b: `honning Vadsø` → 200");
      assertTrue(r.body.count > 0, "0b: `honning Vadsø` returns the nationwide honey producers (the live symptom)");
      // THE regression: this was `true` on origin/main.
      assertEq(r.body.geoFiltered, false, "0b: geoFiltered is FALSE once the geo filter was dropped");
      assertEq(r.body.relaxed_filters, ["geo"], "0b: relaxed_filters names the dropped filter");
      assertTrue(typeof r.body.note === "string" && /hele Norge/.test(r.body.note),
        `0b: a human-readable note explains the widening (got ${JSON.stringify(r.body.note)})`);
      assertTrue(/Vadsø/.test(String(r.body.note)),
        "0b: the note names the place we found nothing near");
      assertEq(r.body.geoSource, "none", "0b: geoSource no longer advertises the abandoned geocode");
      assertEq(r.body.parsed.location, undefined, "0b: the echoed parsed block drops the location too");
      // Sanity: the far-away producers really are the ones returned.
      const names = r.body.results.map((x: any) => x.agent.name);
      assertTrue(names.some((n: string) => /Tønsberg|Melhus|Røros/.test(n)),
        `0b: the returned producers are the far-away ones (${names.join(", ")})`);
    }

    // A geo search that DOES find something locally stays honestly filtered.
    {
      const r = await callRoute(router, {
        url: "/search",
        query: { q: "gårdsutsalg", lat: String(AGDER.lat), lng: String(AGDER.lng), radius: "90" },
      });
      assertEq(r.body.geoFiltered, true, "0b: a genuinely geo-filtered search still reports geoFiltered:true");
      assertEq(r.body.relaxed_filters, undefined, "0b: …with no relaxed_filters");
      assertEq(r.body.note, undefined, "0b: …and no relaxation note");
    }

    // ════════════════════════════════════════════════════════════════
    // 0d — name search must not switch geo filtering off
    // ════════════════════════════════════════════════════════════════
    {
      const parsed = marketplaceRegistry.parseNaturalQuery("gårdsutsalg i Agder");
      assertTrue(!!(parsed as any)._nameQuery,
        "0d: `gårdsutsalg i Agder` really does take the _nameQuery branch (the bug's precondition)");
    }
    {
      const r = await callRoute(router, { url: "/search", query: { q: "gårdsutsalg i Agder" } });
      assertEq(r.status, 200, "0d: `gårdsutsalg i Agder` → 200");
      const names: string[] = r.body.results.map((x: any) => x.agent.name);
      const scores: number[] = r.body.results.map((x: any) => x.relevanceScore);
      assertTrue(names.length > 0, "0d: returns results");
      assertEq(names[0], "Sørlandet Gårdsutsalg",
        `0d: the in-region Agder producer ranks FIRST (got ${names.join(", ")})`);
      assertTrue(!names.includes("Sørum Gårdsutsalg") && !names.includes("Stange Gårdsutsalg"),
        `0d: the 277 km / 318 km namesakes are gone (got ${names.join(", ")})`);
      assertTrue(new Set(scores).size === scores.length || scores.length === 1,
        `0d: scores are no longer a flat 0.750 tie (got ${JSON.stringify(scores)})`);
      const d = r.body.results[0]?.agent?.location?.distanceKm;
      assertTrue(typeof d === "number" && d < 90,
        `0d: the top hit carries a real distance inside the Agder radius (got ${d})`);
    }

    // …but a pure name lookup with NO location must still find the producer
    // wherever they are (the "Erga Gårdsutsalg" regression guard).
    {
      const r = await callRoute(router, { url: "/search", query: { q: "Stange Gårdsutsalg", heleNorge: "true" } });
      const names: string[] = r.body.results.map((x: any) => x.agent.name);
      assertTrue(names.includes("Stange Gårdsutsalg"),
        `0d: a name lookup with no location still finds the producer (got ${names.join(", ")})`);
    }
    // …and a name lookup whose target is far from the user is not silently
    // swallowed just because a location was resolved.
    {
      const r = await callRoute(router, {
        url: "/search",
        query: { q: "Stange Gårdsutsalg", lat: String(VADSO.lat), lng: String(VADSO.lng), radius: "25" },
      });
      const names: string[] = r.body.results.map((x: any) => x.agent.name);
      assertTrue(names.includes("Stange Gårdsutsalg"),
        `0d: a named producer far from the user is still returned, not hidden (got ${names.join(", ")})`);
    }

    // ════════════════════════════════════════════════════════════════
    // 0e — «nær meg» is an intent, not a stopword
    // ════════════════════════════════════════════════════════════════
    assertTrue(isProximityIntent("nær meg"), "0e: 'nær meg' detected as proximity intent");
    assertTrue(isProximityIntent("hvor er nærmeste gårdsbutikk"), "0e: 'hvor er nærmeste …' detected");
    assertTrue(isProximityIntent("honning i nærheten"), "0e: 'i nærheten' detected");
    assertTrue(isProximityIntent("farms near me"), "0e: English 'near me' detected");
    assertTrue(!isProximityIntent("honning nær Oslo"),
      "0e: the PREPOSITION 'nær <sted>' is NOT hijacked into a position request");
    assertTrue(!isProximityIntent("grønnsaker oslo"), "0e: a plain place search is not proximity intent");
    {
      const r = await callRoute(router, { url: "/search", query: { q: "nær meg" } });
      assertEq(r.status, 200, "0e: `nær meg` → 200");
      assertEq(r.body.needs_location, true, "0e: response signals needs_location:true");
      assertEq(r.body.geoFiltered, false, "0e: …and does not pretend to be geo-filtered");
      assertTrue(typeof r.body.note === "string" && /lat\/lng/.test(r.body.note),
        `0e: the note tells the caller how to supply a position (got ${JSON.stringify(r.body.note)})`);
      assertEq(r.body.parsed._proximityIntent, true, "0e: the parsed block carries the intent");
    }
    {
      // Same words, but the caller DID give us coordinates → no nagging.
      const r = await callRoute(router, {
        url: "/search",
        query: { q: "nær meg", lat: String(AGDER.lat), lng: String(AGDER.lng), radius: "90" },
      });
      assertEq(r.body.needs_location, undefined, "0e: with coordinates supplied, needs_location is absent");
      assertEq(r.body.geoFiltered, true, "0e: …and the search really is geo-filtered");
    }

    // ════════════════════════════════════════════════════════════════
    // 0f — proximity search without typing anything
    // ════════════════════════════════════════════════════════════════
    {
      const r = await callRoute(router, {
        url: "/search",
        query: { lat: String(AGDER.lat), lng: String(AGDER.lng), radius: "90" },
      });
      assertEq(r.status, 200, "0f: coordinates-only search returns 200 (was 400 'Mangler ?q=')");
      assertTrue(r.body.count > 0, `0f: …with results (got ${r.body.count})`);
      assertEq(r.body.geoFiltered, true, "0f: …honestly reported as geo-filtered");
      assertEq(r.body.geoSource, "browser", "0f: …sourced from the supplied browser position");
      // Honest radius reporting: only one seeded producer sits inside 90 km,
      // so the auto-expand ladder widens — and geoRadiusKm says so. What it
      // must never do is report a radius NARROWER than the one requested
      // (the fixed [50,100,200] ladder used to start below a 90 km request).
      assertTrue(typeof r.body.geoRadiusKm === "number" && r.body.geoRadiusKm >= 90,
        `0f: geoRadiusKm reports the radius actually applied and never narrows below the request (got ${r.body.geoRadiusKm})`);
      const names: string[] = r.body.results.map((x: any) => x.agent.name);
      assertTrue(names.includes("Sørlandet Gårdsutsalg"),
        `0f: the nearby producer is found without any text query (got ${names.join(", ")})`);
      assertTrue(!names.includes("Sørum Gårdsutsalg"),
        "0f: …and a 500 km-away producer is not");
    }
    {
      const r = await callRoute(router, { url: "/search", query: {} });
      assertEq(r.status, 400, "0f: neither q nor coordinates is still a 400");
      assertTrue(/lat/.test(String(r.body.error)),
        "0f: …and the error now mentions the coordinates alternative");
    }
    {
      const r = await callRoute(router, { url: "/search", query: { lat: "999", lng: "10" } });
      assertEq(r.status, 400, "0f: an out-of-range latitude is rejected, not treated as a position");
    }
    // Radius is user-adjustable, clamped like OpplevAgent's 1–500 km.
    assertEq(resolveSearchRadiusKm(undefined), 30, "0f: default radius unchanged at 30 km");
    assertEq(resolveSearchRadiusKm("75"), 75, "0f: caller-supplied radius honoured");
    assertEq(resolveSearchRadiusKm("9999"), 500, "0f: radius clamped to 500 km");
    assertEq(resolveSearchRadiusKm("0"), 30, "0f: zero radius falls back to the default");
    assertEq(resolveSearchRadiusKm("abc"), 30, "0f: garbage radius falls back to the default");
    assertTrue(isValidLatLng(60, 10), "0f: isValidLatLng accepts a real coordinate pair");
    assertTrue(!isValidLatLng(NaN, 10), "0f: isValidLatLng rejects NaN");
    assertTrue(!isValidLatLng(60, 999), "0f: isValidLatLng rejects an out-of-range longitude");

    // ════════════════════════════════════════════════════════════════
    // 0g(ii) — SECURITY: a read-only search must not email farmers
    // ════════════════════════════════════════════════════════════════
    {
      const before = convCount();
      const r = await callRoute(router, {
        url: "/search",
        query: { q: "gårdsutsalg" },
        // Exactly the header shape every MCP/AI client sends — this is what
        // used to trip the auto-conversation branch.
        headers: { accept: "application/json", "user-agent": "Claude-User/1.0" },
      });
      assertTrue(r.body.count > 0, "0g(ii): the AI-shaped request still gets its results");
      assertEq(convCount(), before,
        "0g(ii): NO conversation row was written for a read-only search by an AI client");
      assertEq(r.body.conversations, [], "0g(ii): …and the response reports no conversations");
    }
    {
      // The opt-in path still works for a caller that explicitly wants contact.
      const before = convCount();
      await callRoute(router, {
        url: "/search",
        query: { q: "gårdsutsalg", start_conversation: "true" },
        headers: { accept: "application/json", "user-agent": "Claude-User/1.0" },
      });
      assertTrue(convCount() > before,
        "0g(ii): ?start_conversation=true is still honoured (explicit opt-in preserved)");
    }

    // ── pure helper: the note builder ────────────────────────────────
    assertEq(buildSearchNote({}), undefined, "note: nothing to say → undefined");
    assertTrue(/Vadsø/.test(String(buildSearchNote({ geoDropped: true, geoPlaceLabel: "Vadsø" }))),
      "note: geo-dropped note names the place");
    assertTrue(/lat\/lng/.test(String(buildSearchNote({ needsLocation: true }))),
      "note: needs-location note asks for coordinates");
  } finally {
    console.log = prevLogLevel;
    __setGeocodingFetchForTesting();
    __clearGeocodeCacheForTesting();
    // Deliberately NOT db.close(): this handle is still the shared getDb()
    // singleton (__setDbForTesting has no restore hook), and closing it would
    // break any later block that reads the singleton. Same discipline as the
    // other singleton-swapping suites in tests/test.ts.
  }

  return { passed, failed, failures };
}

// Standalone runner
if (require.main === module) {
  runMarketplaceSearchHonestyTests({ log: true }).then((s) => {
    console.log(`\n${s.passed} passed, ${s.failed} failed`);
    // Explicit exit: requiring the route modules leaves background timers open.
    process.exit(s.failed > 0 ? 1 : 0);
  });
}
